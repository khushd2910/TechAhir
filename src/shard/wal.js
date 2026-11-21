'use strict';
const fs = require('fs');
const fsp = fs.promises;

// Append-only write-ahead log (one JSON event per line) with GROUP COMMIT.
// append() returns a promise that resolves only when the event is on disk.
// While one batch is being written, new events pile up and go out together
// in the next write, so thousands of bids cost a handful of fsyncs.
class Wal {
  constructor({ file, fsync = true }) {
    this.file = file;
    this.fsync = fsync;
    this.buf = [];
    this.waiters = [];
    this.busy = false;
    this.queued = false;
    this.fh = null;
    this.stats = { flushes: 0, records: 0, bytes: 0 };
  }

  async open() {
    this.fh = await fsp.open(this.file, 'a');
  }

  append(ev) {
    return new Promise((resolve, reject) => {
      this.buf.push(JSON.stringify(ev) + '\n');
      this.waiters.push({ resolve, reject });
      this._kick();
    });
  }

  _kick() {
    if (this.busy || this.queued) return;
    this.queued = true;
    setImmediate(() => this._flush());
  }

  async _flush() {
    this.queued = false;
    if (this.busy || !this.buf.length) return;
    this.busy = true;
    const data = this.buf.join('');
    const waiters = this.waiters;
    this.buf = [];
    this.waiters = [];
    try {
      await this.fh.appendFile(data);
      if (this.fsync) await this.fh.sync();
      this.stats.flushes++;
      this.stats.records += waiters.length;
      this.stats.bytes += data.length;
      for (const w of waiters) w.resolve();
    } catch (err) {
      for (const w of waiters) w.reject(err);
    } finally {
      this.busy = false;
      if (this.buf.length) this._kick();
    }
  }

  async close() {
    while (this.buf.length || this.busy) await new Promise((r) => setTimeout(r, 2));
    if (this.fh) await this.fh.close();
    this.fh = null;
  }

  // Read every complete line. A torn last line (crash mid-write) is cut off
  // so new events never get glued onto half a record.
  static replay(file, onEvent) {
    if (!fs.existsSync(file)) return { count: 0, truncated: 0 };
    const buf = fs.readFileSync(file);
    let pos = 0;
    let count = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf(10, pos);
      if (nl === -1) break;
      let ev;
      try { ev = JSON.parse(buf.toString('utf8', pos, nl)); } catch { break; }
      onEvent(ev);
      count++;
      pos = nl + 1;
    }
    let truncated = 0;
    if (pos < buf.length) {
      truncated = buf.length - pos;
      fs.truncateSync(file, pos);
    }
    return { count, truncated };
  }
}
module.exports = { Wal };
