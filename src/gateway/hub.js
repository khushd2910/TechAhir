'use strict';
const { minNextBid } = require('../core/auction');

// The gateway's READ side. It keeps the latest snapshot of every auction
// (the catalog) and pushes changes to watchers over Server-Sent Events.
//
// Scale tricks used here:
//  * Conflation: updates are full snapshots, so if a watcher is slow we simply
//    skip frames; the next one carries the latest state anyway.
//  * Serialize once per update, then write the same string to every watcher.
//  * Backpressure: a watcher whose socket buffer is full is skipped, and
//    dropped if it stays behind. One slow phone can't hold memory hostage.
//  * Reads (list / get / initial snapshots) are served from memory and never
//    touch the shards, so shards only do bidding.
class Hub {
  constructor({ maxBuffer, maxLagFrames, heartbeatMs }) {
    this.maxBuffer = maxBuffer;
    this.maxLagFrames = maxLagFrames;
    this.catalog = new Map();   // id -> latest snapshot
    this.subs = new Map();      // id -> Set<client>
    this.clients = new Set();
    this.counts = { framesSent: 0, framesSkipped: 0, slowDropped: 0, connects: 0 };
    this.listCache = new Map();
    this.hb = setInterval(() => this._heartbeat(), heartbeatMs);
    this.hb.unref();
  }

  get(id) { return this.catalog.get(id); }

  // Apply snapshots from a shard (or a create response). Stale ones are ignored.
  apply(items, now = Date.now()) {
    for (const it of items) {
      const cur = this.catalog.get(it.id);
      if (cur && it.v <= cur.v) continue;
      this.catalog.set(it.id, it);
      const set = this.subs.get(it.id);
      if (!set || !set.size) continue;
      const frame = `event: u\ndata: ${JSON.stringify({ ...it, now })}\n\n`;
      const force = it.status === 'closed'; // the result must always be delivered
      for (const c of set) this._send(c, frame, force);
    }
  }

  _send(c, frame, force) {
    const res = c.res;
    if (res.destroyed || res.writableEnded) return;
    if (!force && (res.writableNeedDrain || res.writableLength > this.maxBuffer)) {
      this.counts.framesSkipped++;
      if (++c.lag > this.maxLagFrames) {
        this.counts.slowDropped++;
        res.destroy();
      }
      return;
    }
    c.lag = 0;
    res.write(frame);
    this.counts.framesSent++;
  }

  connect(req, res, ids) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2000\n\n');
    const c = { res, ids, lag: 0 };
    this.clients.add(c);
    this.counts.connects++;
    const now = Date.now();
    for (const id of ids) {
      let s = this.subs.get(id);
      if (!s) { s = new Set(); this.subs.set(id, s); }
      s.add(c);
      const snap = this.catalog.get(id);
      if (snap) res.write(`event: u\ndata: ${JSON.stringify({ ...snap, now })}\n\n`);
    }
    const cleanup = () => this._remove(c);
    req.on('close', cleanup);
    res.on('error', cleanup);
  }

  _remove(c) {
    if (!this.clients.delete(c)) return;
    for (const id of c.ids) {
      const s = this.subs.get(id);
      if (!s) continue;
      s.delete(c);
      if (!s.size) this.subs.delete(id);
    }
  }

  _heartbeat() {
    for (const c of this.clients) {
      if (!c.res.writableNeedDrain && !c.res.destroyed) c.res.write(': ping\n\n');
    }
  }

  closeAll() {
    clearInterval(this.hb);
    for (const c of [...this.clients]) c.res.destroy();
  }

  // Catalog queries (cached for 500ms so a busy lobby doesn't re-sort 50k rows per request).
  list({ status = 'open', sort = 'ending', q = '', limit = 24, offset = 0 }) {
    const key = [status, sort, q, limit, offset].join('|');
    const hit = this.listCache.get(key);
    const t = Date.now();
    if (hit && t - hit.at < 500) return hit.value;

    const needle = q.toLowerCase();
    let rows = [];
    let open = 0, closed = 0;
    for (const s of this.catalog.values()) {
      if (s.status === 'open') open++; else closed++;
      if (status !== 'all' && s.status !== status) continue;
      if (needle && !(s.title.toLowerCase().includes(needle) || s.id.toLowerCase().includes(needle))) continue;
      rows.push(s);
    }
    if (sort === 'hot') rows.sort((a, b) => b.bids - a.bids || a.endsAt - b.endsAt);
    else if (sort === 'price') rows.sort((a, b) => b.price - a.price);
    else rows.sort((a, b) => a.endsAt - b.endsAt);

    const value = { total: rows.length, counts: { open, closed }, items: rows.slice(offset, offset + limit) };
    this.listCache.set(key, { at: t, value });
    if (this.listCache.size > 200) this.listCache.delete(this.listCache.keys().next().value);
    return value;
  }

  stats() {
    return { catalog: this.catalog.size, watchers: this.clients.size, subscribedAuctions: this.subs.size, ...this.counts };
  }
}

module.exports = { Hub, minNextBid };
