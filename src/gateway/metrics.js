'use strict';
// Tiny counters + latency histogram (no dependencies).
const BUCKETS = [0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 5000, Infinity];

class Metrics {
  constructor() {
    this.counters = Object.create(null);
    this.hist = new Array(BUCKETS.length).fill(0);
    this.histCount = 0;
    this.startedAt = Date.now();
  }
  inc(name, n = 1) { this.counters[name] = (this.counters[name] || 0) + n; }
  observe(ms) {
    this.histCount++;
    for (let i = 0; i < BUCKETS.length; i++) {
      if (ms <= BUCKETS[i]) { this.hist[i]++; return; }
    }
  }
  percentile(p) {
    if (!this.histCount) return 0;
    const target = Math.ceil((p / 100) * this.histCount);
    let seen = 0;
    for (let i = 0; i < BUCKETS.length; i++) {
      seen += this.hist[i];
      if (seen >= target) return BUCKETS[i];
    }
    return BUCKETS[BUCKETS.length - 2];
  }
  snapshot() {
    return {
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      counters: { ...this.counters },
      bidLatencyMs: { p50: this.percentile(50), p95: this.percentile(95), p99: this.percentile(99), samples: this.histCount }
    };
  }
}
module.exports = { Metrics };
