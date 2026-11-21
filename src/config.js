'use strict';
const os = require('os');
const path = require('path');

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

// Every knob can be set by env var or by passing overrides (tests do this).
module.exports = function loadConfig(overrides = {}) {
  const e = process.env;
  return {
    host: e.HOST || '0.0.0.0',
    port: num(e.PORT, 3000),
    shards: num(e.SHARDS, Math.max(2, Math.min(4, os.cpus().length))),
    dataDir: e.DATA_DIR || path.join(__dirname, '..', 'data'),

    // Auction rules (from the brief: bid in the last 30s extends by 30s)
    extendWindowMs: num(e.EXTEND_WINDOW_MS, 30_000),
    extendByMs: num(e.EXTEND_BY_MS, 30_000),

    // Durability: acknowledge a bid only after its WAL batch is on disk.
    fsync: e.WAL_FSYNC !== '0',

    // Fan-out: at most one update per auction per flushMs (conflation).
    flushMs: num(e.FLUSH_MS, 100),
    maxClientBuffer: num(e.MAX_CLIENT_BUFFER, 256 * 1024), // bytes queued per watcher
    maxClientLagFrames: num(e.MAX_CLIENT_LAG, 200),       // frames skipped before disconnect
    heartbeatMs: num(e.HEARTBEAT_MS, 15_000),

    // Abuse protection (token buckets)
    bidderBurst: num(e.BIDDER_BURST, 20),
    bidderPerSec: num(e.BIDDER_PER_SEC, 10),
    ipBurst: num(e.IP_BURST, 2000),
    ipPerSec: num(e.IP_PER_SEC, 1000),

    adminKey: e.ADMIN_KEY || '',
    chaos: e.CHAOS === '1', // allows killing a shard on purpose (tests)
    quiet: false,
    ...overrides
  };
};
