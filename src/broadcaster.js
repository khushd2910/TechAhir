// Fan-out to watchers over Server-Sent Events.
// Updates are coalesced: at most one message per auction per FLUSH_MS, so a
// burst of 1,000 bids in a second becomes ~10 messages per watcher.

const FLUSH_MS = 100;

class Broadcaster {
  constructor() {
    this.watchers = new Map(); // auctionId -> Set<res>
    this.dirty = new Set();
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    this.timer.unref();
  }

  subscribe(auctionId, res) {
    if (!this.watchers.has(auctionId)) this.watchers.set(auctionId, new Set());
    this.watchers.get(auctionId).add(res);
    res.on('close', () => this.watchers.get(auctionId)?.delete(res));
  }

  markDirty(auctionId) {
    this.dirty.add(auctionId);
  }

  send(auctionId, payload) {
    const set = this.watchers.get(auctionId);
    if (!set) return;
    const msg = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of set) res.write(msg);
  }

  flush() {
    for (const id of this.dirty) this.onFlush?.(id);
    this.dirty.clear();
  }
}

module.exports = { Broadcaster };
