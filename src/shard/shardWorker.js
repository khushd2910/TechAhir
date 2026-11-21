'use strict';
// One shard = one worker thread = single owner of its auctions.
// Because only this thread ever touches these auctions, bids for the same
// auction are processed strictly one after another: no locks, one total order.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');
const { AuctionBook } = require('../core/auction');
const { CloseScheduler } = require('../core/scheduler');
const { Wal } = require('./wal');

const { index, dataDir, cfg } = workerData;
const book = new AuctionBook({ extendWindowMs: cfg.extendWindowMs, extendByMs: cfg.extendByMs });
const wal = new Wal({ file: path.join(dataDir, `shard-${index}.wal`), fsync: cfg.fsync });
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();

// ---- outgoing updates: conflated, and only AFTER the change is durable ----
const pending = new Set();
let immediateQueued = false;
let flushTimer = null;

function queueUpdate(id, urgent) {
  pending.add(id);
  if (urgent && !immediateQueued) {
    immediateQueued = true;
    setImmediate(() => { immediateQueued = false; flushUpdates(); });
  }
}

function flushUpdates() {
  if (!pending.size) return;
  const items = [];
  for (const id of pending) {
    const a = book.get(id);
    if (a) items.push(book.snap(a));
  }
  pending.clear();
  parentPort.postMessage({ type: 'updates', items, now: Date.now() });
}

// Write events, then publish. A watcher never sees a bid that could be lost.
function persist(events, id, urgent) {
  if (!events.length) return Promise.resolve();
  return Promise.all(events.map((e) => wal.append(e)))
    .then(() => queueUpdate(id, urgent))
    .catch((err) => { err.fatal = true; throw err; });
}

const scheduler = new CloseScheduler({
  onDue(id, t) {
    const a = book.get(id);
    if (!a || a.status !== 'open') return null;
    if (t >= a.endsAt) {
      persist([book.close(id, a.endsAt)], id, true).catch(fatal);
      return null;
    }
    return a.endsAt; // it was extended: check again later
  }
});

function fatal(err) {
  console.error(`[shard ${index}] fatal WAL error, exiting so it can recover from disk:`, err);
  process.exit(1);
}

// ---- operations the gateway can request ----
const handlers = {
  async create({ specs }) {
    const out = [];
    const writes = [];
    for (const spec of specs) {
      const r = book.create(spec);
      if (r.ok) {
        scheduler.schedule(spec.id, r.auction.endsAt);
        writes.push(persist(r.events, spec.id, false));
      }
      out.push({ ok: r.ok, reason: r.reason, auction: r.auction });
    }
    await Promise.all(writes);
    return out;
  },

  async bid({ id, bidder, amount, requestId }) {
    const r = book.placeBid({ id, bidder, amount, requestId });
    const closed = r.events.some((e) => e.t === 'x');
    await persist(r.events, id, closed || !!r.extended);
    delete r.events;
    return r;
  },

  async detail({ id }) {
    const a = book.get(id);
    return a ? { auction: book.snap(a), recent: book.recent(id) } : null;
  },

  async stats() {
    let open = 0, closed = 0, bids = 0;
    for (const a of book.auctions.values()) {
      if (a.status === 'open') open++; else closed++;
      bids += a.bids;
    }
    const s = {
      shard: index, auctions: book.auctions.size, open, closed, bids,
      scheduled: scheduler.size,
      wal: { ...wal.stats, avgBatch: wal.stats.flushes ? +(wal.stats.records / wal.stats.flushes).toFixed(1) : 0 },
      loopP99ms: +(loop.percentile(99) / 1e6).toFixed(2),
      loopMaxMs: +(loop.max / 1e6).toFixed(2)
    };
    loop.reset();
    return s;
  },

  async shutdown() {
    scheduler.stop();
    clearInterval(flushTimer);
    flushUpdates();
    await wal.close();
    return true;
  },

  async crash() {
    if (!cfg.chaos) throw new Error('chaos disabled');
    setImmediate(() => process.exit(1));
    return true;
  }
};

// ---- startup: recover from the log, then announce ----
async function init() {
  fs.mkdirSync(dataDir, { recursive: true });
  const t0 = Date.now();
  const rep = Wal.replay(wal.file, (ev) => book.applyEvent(ev));
  await wal.open();

  // Auctions that ended while we were down are closed now, at their endsAt.
  const t = Date.now();
  const closing = [];
  for (const a of book.auctions.values()) {
    if (a.status !== 'open') continue;
    if (t >= a.endsAt) closing.push(book.close(a.id, a.endsAt));
    else scheduler.schedule(a.id, a.endsAt);
  }
  await Promise.all(closing.map((e) => wal.append(e)));

  const all = [...book.auctions.values()].map((a) => book.snap(a));
  for (let i = 0; i < all.length; i += 2000) {
    parentPort.postMessage({ type: 'snapshot', items: all.slice(i, i + 2000) });
  }
  flushTimer = setInterval(flushUpdates, cfg.flushMs);
  parentPort.postMessage({
    type: 'ready', index,
    recovered: { events: rep.count, truncatedBytes: rep.truncated, auctions: all.length, ms: Date.now() - t0 }
  });
}

const ready = init();
parentPort.on('message', async (m) => {
  const { rid, op } = m;
  try {
    await ready;
    const result = await handlers[op](m);
    parentPort.postMessage({ type: 'res', rid, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ type: 'res', rid, ok: false, error: String((err && err.message) || err) });
    if (err && err.fatal) fatal(err);
  }
});
