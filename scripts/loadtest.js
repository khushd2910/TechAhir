#!/usr/bin/env node
'use strict';
// Load test + correctness check.
//   1. seeds thousands of auctions (all open at once)
//   2. connects many watchers to ONE hot auction
//   3. hammers the hot auction (and some others) with concurrent bids
//   4. waits for it to close and verifies: one winner, same winner for every
//      watcher, and the winning amount equals the highest accepted bid.
//
// Start the server with relaxed limits and a short extension window first:
//   BIDDER_PER_SEC=100000 BIDDER_BURST=100000 EXTEND_WINDOW_MS=3000 EXTEND_BY_MS=3000 npm start
const http = require('http');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const BASE = args.url || 'http://localhost:3000';
const AUCTIONS = +(args.auctions || 5000);
const WATCHERS = +(args.watchers || 1000);
const BIDDERS = +(args.bidders || 100);
const SECONDS = +(args.seconds || 10);
const URLO = new URL(BASE);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : 0);
const j = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

(async () => {
  const run = Date.now().toString(36);
  const hot = `hot-${run}`;
  const m0 = (await j('GET', '/api/metrics')).body;
  const cfg = m0.config;
  console.log(`Server: ${cfg.shards} shards, extend ${cfg.extendWindowMs}ms/${cfg.extendByMs}ms, fsync ${cfg.fsync}`);

  // 1. thousands of auctions
  const seed = await j('POST', '/api/admin/seed', { count: AUCTIONS, prefix: `lt${run}`, minDurationMs: 600_000, maxDurationMs: 1_200_000 });
  console.log(`Seeded ${seed.body.created} auctions in ${seed.body.ms}ms`);
  await j('POST', '/api/auctions', { id: hot, title: 'Hot auction', startPrice: 0, minIncrement: 1, durationMs: Math.max(4000, (SECONDS + 2) * 1000) });

  // 2. watchers
  const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
  const watch = { connected: 0, frames: 0, closedWinners: [], lat: [], errors: 0 };
  const tWatch = Date.now();
  await Promise.all(Array.from({ length: WATCHERS }, (_, w) => new Promise((resolve) => {
    let done = false, buf = '', n = 0;
    const req = http.request({ host: URLO.hostname, port: URLO.port || 80, path: `/api/stream?ids=${hot}`, agent }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!frame.startsWith('event: u')) continue;
          watch.frames++;
          if (!done) { done = true; watch.connected++; resolve(); }
          if (frame.includes('"status":"closed"')) {
            watch.closedWinners.push(JSON.parse(frame.slice(frame.indexOf('data: ') + 6)).winner);
          } else if (++n % 20 === 0) {
            const mm = /"now":(\d+)/.exec(frame);
            if (mm) watch.lat.push(Date.now() - Number(mm[1]));
          }
        }
      });
    });
    req.on('error', () => { watch.errors++; if (!done) { done = true; resolve(); } });
    req.end();
  })));
  console.log(`Connected ${watch.connected}/${WATCHERS} watchers in ${Date.now() - tWatch}ms`);

  // 3. bidders
  const stat = { sent: 0, accepted: 0, edge: 0, rejected: 0, limited: 0, errors: 0, lat: [] };
  const price = new Map([[hot, 0]]);
  let best = { amount: 0, bidder: null };
  const deadline = Date.now() + SECONDS * 1000;
  const others = Array.from({ length: 200 }, (_, i) => `lt${run}-${i * 7}`);

  async function bidder(b) {
    const name = `bidder-${b}`;
    while (Date.now() < deadline) {
      const target = Math.random() < 0.8 ? hot : others[(Math.random() * others.length) | 0];
      const amount = (price.get(target) || 100) + 1 + ((Math.random() * 8) | 0);
      const t0 = performance.now();
      stat.sent++;
      try {
        const r = await fetch(`${BASE}/api/auctions/${target}/bids`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': Math.random().toString(36).slice(2) },
          body: JSON.stringify({ bidder: name, amount })
        });
        const body = await r.json();
        stat.lat.push(performance.now() - t0);
        if (body.auction) price.set(target, Math.max(price.get(target) || 0, body.auction.price));
        if (r.status === 429) stat.limited++;
        else if (body.accepted) {
          stat.accepted++;
          if (target === hot && amount > best.amount) best = { amount, bidder: name };
        } else if (body.edge) stat.edge++;
        else stat.rejected++;
      } catch { stat.errors++; }
    }
  }
  const t1 = Date.now();
  await Promise.all(Array.from({ length: BIDDERS }, (_, b) => bidder(b)));
  const elapsed = (Date.now() - t1) / 1000;

  // 4. wait for the hot auction to close, then verify
  const closeBy = Date.now() + cfg.extendByMs + 15_000;
  let final;
  while (Date.now() < closeBy) {
    final = (await j('GET', `/api/auctions/${hot}`)).body.auction;
    if (final.status === 'closed' && watch.closedWinners.length >= watch.connected) break;
    await sleep(200);
  }
  await sleep(300);

  const lat = stat.lat.sort((a, b) => a - b);
  const wl = watch.lat.sort((a, b) => a - b);
  const m1 = (await j('GET', '/api/metrics')).body;
  console.log('\n--- Bidding ---');
  console.log(`bids sent ${stat.sent} in ${elapsed.toFixed(1)}s = ${(stat.sent / elapsed).toFixed(0)}/s`);
  console.log(`accepted ${stat.accepted} | rejected at edge ${stat.edge} | rejected by shard ${stat.rejected} | rate limited ${stat.limited} | errors ${stat.errors}`);
  console.log(`bid latency (client view) p50 ${pct(lat, 50).toFixed(1)}ms  p95 ${pct(lat, 95).toFixed(1)}ms  p99 ${pct(lat, 99).toFixed(1)}ms`);
  console.log('\n--- Watchers ---');
  console.log(`${watch.connected} connected, ${watch.frames} frames received (${(watch.frames / Math.max(1, watch.connected)).toFixed(1)} per watcher)`);
  console.log(`frame delay p50 ${pct(wl, 50)}ms  p99 ${pct(wl, 99)}ms  (server stamp -> received)`);
  const hub = m1.gateway.hub;
  console.log(`server: frames sent ${hub.framesSent}, skipped for slow clients ${hub.framesSkipped}, dropped slow ${hub.slowDropped}`);
  console.log('\n--- Server ---');
  console.log(`rss ${m1.gateway.rssMB}MB | open auctions ${m1.shards.reduce((a, s) => a + s.open, 0)} | server-side bid latency p99 ${m1.gateway.bidLatencyMs.p99}ms`);
  m1.shards.forEach((s) => console.log(`shard ${s.shard}: ${s.auctions} auctions, WAL avg batch ${s.wal.avgBatch} bids/fsync, event-loop p99 ${s.loopP99ms}ms`));

  console.log('\n--- Correctness ---');
  const winners = new Set(watch.closedWinners.map((w) => JSON.stringify(w)));
  const checks = [
    ['hot auction closed', final && final.status === 'closed'],
    ['exactly one winner recorded', !!(final && final.winner)],
    ['winner amount = highest accepted bid', !!(final && final.winner && final.winner.amount === best.amount)],
    ['winner bidder = bidder of highest accepted bid', !!(final && final.winner && final.winner.bidder === best.bidder)],
    ['every watcher saw the result', watch.closedWinners.length === watch.connected],
    ['every watcher saw the SAME winner', winners.size === 1 && winners.has(JSON.stringify(final && final.winner))],
    ['no server errors', stat.errors === 0]
  ];
  let ok = true;
  for (const [name, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`); ok = ok && pass; }
  if (final && final.winner) console.log(`winner: ${final.winner.bidder} with ${final.winner.amount} after ${final.bids} bids`);
  agent.destroy();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
