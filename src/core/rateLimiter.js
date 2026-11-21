'use strict';
// Token bucket per key. Idle keys are swept so memory stays bounded.
class RateLimiter {
  constructor({ burst, perSec, now = Date.now, sweepMs = 60_000 }) {
    this.burst = burst;
    this.perSec = perSec;
    this.now = now;
    this.buckets = new Map();
    if (sweepMs > 0) {
      this.sweeper = setInterval(() => this.sweep(), sweepMs);
      this.sweeper.unref();
    }
  }
  take(key, cost = 1) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.burst, last: t };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.burst, b.tokens + ((t - b.last) / 1000) * this.perSec);
      b.last = t;
    }
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return true;
    }
    return false;
  }
  sweep() {
    const t = this.now();
    for (const [k, b] of this.buckets) {
      if (t - b.last > 60_000) this.buckets.delete(k);
    }
  }
  stop() { if (this.sweeper) clearInterval(this.sweeper); }
}
module.exports = { RateLimiter };
