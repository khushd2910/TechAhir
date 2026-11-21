'use strict';
const http = require('http');
const fs = require('fs');
const loadConfig = require('./config');
const { ShardPool } = require('./shard/shardPool');
const { Hub } = require('./gateway/hub');
const { Metrics } = require('./gateway/metrics');
const { RateLimiter } = require('./core/rateLimiter');
const { createApp } = require('./gateway/app');

async function startServer(overrides = {}) {
  const cfg = loadConfig(overrides);
  fs.mkdirSync(cfg.dataDir, { recursive: true });

  const metrics = new Metrics();
  const hub = new Hub({ maxBuffer: cfg.maxClientBuffer, maxLagFrames: cfg.maxClientLagFrames, heartbeatMs: cfg.heartbeatMs });
  const pool = new ShardPool({ count: cfg.shards, dataDir: cfg.dataDir, cfg });
  const bidderLimiter = new RateLimiter({ burst: cfg.bidderBurst, perSec: cfg.bidderPerSec });
  const ipLimiter = new RateLimiter({ burst: cfg.ipBurst, perSec: cfg.ipPerSec });

  pool.on('updates', (items, now) => hub.apply(items, now));
  pool.on('snapshot', (items) => hub.apply(items, Date.now()));
  pool.on('shard-ready', (i, r) => {
    if (!cfg.quiet) console.log(`[shard ${i}] ready: ${r.auctions} auctions, ${r.events} events replayed in ${r.ms}ms` + (r.truncatedBytes ? `, cut ${r.truncatedBytes} torn bytes` : ''));
  });
  await pool.start();

  const app = createApp({ cfg, pool, hub, metrics, bidderLimiter, ipLimiter });
  const server = http.createServer(app);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  await new Promise((resolve) => server.listen(cfg.port, cfg.host, resolve));

  let closing = null;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      server.close();
      hub.closeAll();
      bidderLimiter.stop();
      ipLimiter.stop();
      if (server.closeAllConnections) server.closeAllConnections();
      await pool.shutdown(); // flushes every WAL before exiting
    })();
    return closing;
  }

  return { cfg, app, server, pool, hub, metrics, port: server.address().port, close };
}

module.exports = { startServer };

if (require.main === module) {
  startServer().then((s) => {
    console.log(`Live auctions on http://localhost:${s.port}  (${s.cfg.shards} shards, fsync ${s.cfg.fsync ? 'on' : 'off'}, extend ${s.cfg.extendWindowMs}ms/${s.cfg.extendByMs}ms)`);
    const stop = async () => { console.log('Shutting down, flushing logs...'); await s.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch((e) => { console.error(e); process.exit(1); });
}
