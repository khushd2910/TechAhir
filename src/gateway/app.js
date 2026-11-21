'use strict';
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { minNextBid } = require('../core/auction');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isInt = (n) => Number.isSafeInteger(n);

function createApp({ cfg, pool, hub, metrics, bidderLimiter, ipLimiter }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));

  const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

  const adminOnly = (req, res, next) => {
    if (cfg.adminKey && req.get('x-admin-key') !== cfg.adminKey) return bad(res, 'admin key required', 401);
    next();
  };

  // ---------- reads (served from memory, never hit the shards) ----------
  app.get('/api/auctions', (req, res) => {
    const status = ['open', 'closed', 'all'].includes(req.query.status) ? req.query.status : 'open';
    const sort = ['ending', 'hot', 'price'].includes(req.query.sort) ? req.query.sort : 'ending';
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 24));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const q = String(req.query.q || '').slice(0, 60);
    res.json({ now: Date.now(), ...hub.list({ status, sort, q, limit, offset }) });
  });

  app.get('/api/auctions/:id', (req, res) => {
    const a = hub.get(req.params.id);
    if (!a) return bad(res, 'NOT_FOUND', 404);
    res.json({ now: Date.now(), auction: a });
  });

  app.get('/api/auctions/:id/bids', async (req, res) => {
    const id = req.params.id;
    if (!hub.get(id)) return bad(res, 'NOT_FOUND', 404);
    try {
      const d = await pool.request(pool.shardFor(id), { op: 'detail', id });
      res.json(d ? d.recent : []);
    } catch (e) { bad(res, e.message, 503); }
  });

  // One connection can follow many auctions (lobby) or just one (detail page).
  app.get('/api/stream', (req, res) => {
    const ids = [...new Set(String(req.query.ids || '').split(',').filter(Boolean))].slice(0, 100);
    if (!ids.length || !ids.every((i) => ID_RE.test(i))) return bad(res, 'ids required');
    if (!ids.some((i) => hub.get(i))) return bad(res, 'NOT_FOUND', 404);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    hub.connect(req, res, ids);
  });

  // ---------- writes ----------
  app.post('/api/auctions/:id/bids', async (req, res) => {
    const t0 = process.hrtime.bigint();
    const id = req.params.id;
    const body = req.body || {};
    const bidder = typeof body.bidder === 'string' ? body.bidder.trim() : '';
    const amount = body.amount;
    const requestId = req.get('Idempotency-Key') || body.requestId;

    if (!ID_RE.test(id)) return bad(res, 'invalid auction id');
    if (!bidder || bidder.length > 40) return bad(res, 'bidder must be 1-40 characters');
    if (!isInt(amount) || amount <= 0) return bad(res, 'amount must be a positive whole number');
    if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length > 64)) return bad(res, 'invalid requestId');

    if (!ipLimiter.take('ip:' + req.ip) || !bidderLimiter.take('b:' + bidder)) {
      metrics.inc('bids_rate_limited');
      res.set('Retry-After', '1');
      return bad(res, 'RATE_LIMITED', 429);
    }
    metrics.inc('bids_total');

    const known = hub.get(id);
    if (!known) return bad(res, 'NOT_FOUND', 404);

    // Edge pre-rejection. Safe because prices only go up and "closed" is final,
    // so a bid that is too low for our (possibly stale) view is too low for real.
    // Requests that carry an Idempotency-Key always go to the shard: it may be
    // a retry of a bid that was already accepted, and only the shard knows.
    if (!requestId && (known.status === 'closed' || amount < minNextBid(known))) {
      const reason = known.status === 'closed' ? 'CLOSED' : 'TOO_LOW';
      metrics.inc('bids_edge_rejected');
      return res.status(409).json({ accepted: false, reason, needed: minNextBid(known), auction: known, edge: true });
    }

    try {
      const r = await pool.request(pool.shardFor(id), { op: 'bid', id, bidder, amount, requestId });
      metrics.observe(Number(process.hrtime.bigint() - t0) / 1e6);
      if (r.auction) hub.apply([r.auction]);
      if (r.ok) {
        metrics.inc(r.duplicate ? 'bids_duplicate' : 'bids_accepted');
        return res.json({ accepted: true, extended: !!r.extended, duplicate: !!r.duplicate, auction: r.auction });
      }
      metrics.inc('bids_rejected_' + r.reason.toLowerCase());
      return res.status(r.reason === 'NOT_FOUND' ? 404 : 409).json({
        accepted: false, reason: r.reason, needed: r.needed, auction: r.auction
      });
    } catch (e) {
      metrics.inc('bids_error');
      return bad(res, e.message, 503);
    }
  });

  async function createMany(specs) {
    const byShard = new Map();
    for (const s of specs) {
      const i = pool.shardFor(s.id);
      if (!byShard.has(i)) byShard.set(i, []);
      byShard.get(i).push(s);
    }
    const results = [];
    await Promise.all([...byShard].map(async ([i, list]) => {
      for (let k = 0; k < list.length; k += 2000) {
        const out = await pool.request(i, { op: 'create', specs: list.slice(k, k + 2000) }, 30_000);
        results.push(...out);
        hub.apply(out.filter((o) => o.auction).map((o) => o.auction));
      }
    }));
    return results;
  }

  const intIn = (v, d, lo, hi) => {
    const n = v === undefined ? d : v;
    return isInt(n) && n >= lo && n <= hi ? n : null;
  };

  app.post('/api/auctions', adminOnly, async (req, res) => {
    const b = req.body || {};
    const id = b.id || crypto.randomBytes(5).toString('hex');
    const startPrice = intIn(b.startPrice, 0, 0, 1e12);
    const minIncrement = intIn(b.minIncrement, 1, 1, 1e12);
    const durationMs = intIn(b.durationMs, 60_000, 100, 30 * 86_400_000);
    if (!ID_RE.test(id)) return bad(res, 'invalid id');
    if (startPrice === null || minIncrement === null || durationMs === null) return bad(res, 'invalid startPrice, minIncrement or durationMs');
    const title = String(b.title || id).slice(0, 80);
    try {
      const [r] = await createMany([{ id, title, startPrice, minIncrement, durationMs }]);
      if (!r.ok) return res.status(409).json({ error: r.reason, auction: r.auction });
      res.status(201).json(r.auction);
    } catch (e) { bad(res, e.message, 503); }
  });

  // Create thousands of auctions at once (demo / load testing).
  app.post('/api/admin/seed', adminOnly, async (req, res) => {
    const b = req.body || {};
    const count = intIn(b.count, 1000, 1, 100_000);
    const minMs = intIn(b.minDurationMs, 120_000, 100, 30 * 86_400_000);
    const maxMs = intIn(b.maxDurationMs, 900_000, 100, 30 * 86_400_000);
    const startPrice = intIn(b.startPrice, 100, 0, 1e12);
    const prefix = String(b.prefix || 'auc').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20) || 'auc';
    if ([count, minMs, maxMs, startPrice].includes(null) || maxMs < minMs) return bad(res, 'invalid seed parameters');
    const t0 = Date.now();
    const nouns = ['Vase', 'Camera', 'Guitar', 'Watch', 'Painting', 'Typewriter', 'Bicycle', 'Lamp', 'Globe', 'Chess set', 'Radio', 'Rug'];
    const specs = Array.from({ length: count }, (_, i) => ({
      id: `${prefix}-${i}`,
      title: `${nouns[i % nouns.length]} #${i}`,
      startPrice: startPrice + (i % 50) * 10,
      minIncrement: 5 + (i % 5) * 5,
      durationMs: minMs + Math.floor(Math.random() * (maxMs - minMs + 1))
    }));
    try {
      const out = await createMany(specs);
      res.json({ requested: count, created: out.filter((o) => o.ok).length, ms: Date.now() - t0 });
    } catch (e) { bad(res, e.message, 503); }
  });

  // ---------- ops ----------
  app.get('/healthz', (req, res) => res.status(pool.isReady() ? 200 : 503).json({ ready: pool.isReady() }));

  app.get('/api/metrics', async (req, res) => {
    const shards = await pool.stats();
    const m = process.memoryUsage();
    res.json({
      config: { shards: cfg.shards, extendWindowMs: cfg.extendWindowMs, extendByMs: cfg.extendByMs, flushMs: cfg.flushMs, fsync: cfg.fsync },
      gateway: { ...metrics.snapshot(), hub: hub.stats(), rssMB: Math.round(m.rss / 1048576), heapMB: Math.round(m.heapUsed / 1048576) },
      shards
    });
  });

  app.use(express.static(path.join(__dirname, '..', '..', 'public')));
  return app;
}

module.exports = { createApp };
