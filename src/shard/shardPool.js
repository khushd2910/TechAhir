'use strict';
const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');
const path = require('path');
const { shardFor } = require('../core/hash');

// Gateway-side handle on all shard workers: routing, request/response,
// and automatic restart (the new worker replays its WAL).
class ShardPool extends EventEmitter {
  constructor({ count, dataDir, cfg }) {
    super();
    this.count = count;
    this.dataDir = dataDir;
    this.cfg = {
      fsync: cfg.fsync, flushMs: cfg.flushMs, chaos: cfg.chaos,
      extendWindowMs: cfg.extendWindowMs, extendByMs: cfg.extendByMs
    };
    this.quiet = !!cfg.quiet;
    this.workers = [];
    this.ready = [];
    this.pending = new Map();
    this.nextRid = 1;
    this.stopping = false;
  }

  shardFor(id) { return shardFor(id, this.count); }
  isReady() { return this.ready.length === this.count && this.ready.every(Boolean); }

  start() {
    return Promise.all(Array.from({ length: this.count }, (_, i) => this._spawn(i)));
  }

  _spawn(i) {
    return new Promise((resolve, reject) => {
      const w = new Worker(path.join(__dirname, 'shardWorker.js'), {
        workerData: { index: i, dataDir: this.dataDir, cfg: this.cfg }
      });
      this.workers[i] = w;
      this.ready[i] = false;
      let settled = false;

      w.on('message', (m) => {
        switch (m.type) {
          case 'res': {
            const p = this.pending.get(m.rid);
            if (!p) return;
            this.pending.delete(m.rid);
            clearTimeout(p.timer);
            if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error));
            break;
          }
          case 'updates': this.emit('updates', m.items, m.now); break;
          case 'snapshot': this.emit('snapshot', m.items); break;
          case 'ready':
            this.ready[i] = true;
            this.emit('shard-ready', i, m.recovered);
            if (!settled) { settled = true; resolve(); }
            break;
        }
      });
      w.on('error', (err) => {
        if (!this.quiet) console.error(`[shard ${i}] error:`, err);
        if (!settled) { settled = true; reject(err); }
      });
      w.on('exit', (code) => {
        this.ready[i] = false;
        this._failPending(i, 'SHARD_DOWN');
        if (!this.stopping) {
          if (!this.quiet) console.error(`[shard ${i}] exited with code ${code}; restarting from its log`);
          setTimeout(() => this._spawn(i).catch((e) => console.error(e)), 200);
        }
      });
    });
  }

  _failPending(shard, reason) {
    for (const [rid, p] of this.pending) {
      if (p.shard !== shard) continue;
      this.pending.delete(rid);
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
  }

  request(shard, msg, timeoutMs = 5000) {
    if (!this.ready[shard]) return Promise.reject(new Error('SHARD_DOWN'));
    return new Promise((resolve, reject) => {
      const rid = this.nextRid++;
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error('SHARD_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(rid, { resolve, reject, timer, shard });
      this.workers[shard].postMessage({ rid, ...msg });
    });
  }

  async stats() {
    return Promise.all(this.workers.map((_, i) => this.request(i, { op: 'stats' }).catch(() => ({ shard: i, down: true }))));
  }

  async shutdown() {
    this.stopping = true;
    await Promise.all(this.workers.map(async (w, i) => {
      if (this.ready[i]) await this.request(i, { op: 'shutdown' }, 10_000).catch(() => {});
      await w.terminate();
    }));
  }
}
module.exports = { ShardPool };
