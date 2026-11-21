'use strict';
const { MinHeap } = require('./heap');

// Closes auctions on time without polling.
// - One heap entry per auction, one OS timer for the earliest deadline.
// - When an auction is extended we do NOT touch the heap. When the old entry
//   fires, onDue() sees the later endsAt and returns it, and we re-queue.
//   So a hot auction with 10,000 late bids still costs one heap entry.
// Cost for 50,000 auctions: O(log n) per close instead of scanning all of them.
class CloseScheduler {
  constructor({ now = Date.now, onDue }) {
    this.now = now;
    this.onDue = onDue; // (id, now) => nextEndsAt | null
    this.heap = new MinHeap();
    this.scheduled = new Set();
    this.timer = null;
    this.armedFor = Infinity;
  }
  get size() { return this.heap.size; }

  schedule(id, at) {
    if (this.scheduled.has(id)) return;
    this.scheduled.add(id);
    this.heap.push({ id, at });
    this._arm();
  }

  _arm() {
    const top = this.heap.peek();
    if (!top) return;
    if (this.timer && this.armedFor <= top.at) return;
    if (this.timer) clearTimeout(this.timer);
    this.armedFor = top.at;
    const delay = Math.min(Math.max(1, top.at - this.now()), 2 ** 31 - 1);
    this.timer = setTimeout(() => this.runDue(), delay);
  }

  runDue() {
    this.timer = null;
    this.armedFor = Infinity;
    const t = this.now();
    let top;
    while ((top = this.heap.peek()) && top.at <= t) {
      this.heap.pop();
      this.scheduled.delete(top.id);
      const next = this.onDue(top.id, t);
      if (next != null && next > t) {
        this.scheduled.add(top.id);
        this.heap.push({ id: top.id, at: next });
      }
    }
    this._arm();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.armedFor = Infinity;
  }
}
module.exports = { CloseScheduler };
