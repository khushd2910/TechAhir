// Core auction logic. No I/O, no timers: easy to test and reason about.
// Node runs this on one thread, so placeBid() is atomic per call. Bids are
// processed strictly one at a time, which gives a single total order of bids.

const EXTEND_WINDOW_MS = 30_000; // a bid in the last 30s...
const EXTEND_BY_MS = 30_000;     // ...pushes the end time out by 30s

class AuctionStore {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.auctions = new Map();
    this.seq = 0; // global bid sequence number = arrival order
  }

  create({
    id,
    title = `Auction ${id}`,
    category = 'Collectibles',
    location = 'Global',
    image = '',
    startPrice = 0,
    durationMs = 60_000,
    minIncrement = 1
  }) {
    if (this.auctions.has(id)) throw new Error('Auction already exists');
    const auction = {
      id,
      title,
      category,
      location,
      image,
      lots: [],
      status: 'open',
      currentPrice: startPrice,
      minIncrement,
      leader: null,
      endsAt: this.now() + durationMs,
      bidCount: 0,
      winner: null,
      log: [] // accepted bids in order (an append-only log in a real system)
    };
    this.auctions.set(id, auction);
    return auction;
  }

  list() {
    return [...this.auctions.values()];
  }

  get(id) {
    return this.auctions.get(id);
  }

  // Close exactly once: open -> closed is a one-way transition.
  close(id) {
    const a = this.auctions.get(id);
    if (!a || a.status === 'closed') return false;
    a.status = 'closed';
    a.winner = a.leader ? { bidder: a.leader, amount: a.currentPrice } : null;
    return true;
  }

  placeBid(id, bidder, amount) {
    const a = this.auctions.get(id);
    if (!a) return { ok: false, reason: 'NOT_FOUND' };

    const t = this.now();
    // Lazy close: never accept a bid after the end time, even if the
    // background timer has not fired yet.
    if (a.status === 'open' && t >= a.endsAt) this.close(id);
    if (a.status === 'closed') return { ok: false, reason: 'CLOSED', auction: a };

    const needed = a.leader === null ? a.currentPrice : a.currentPrice + a.minIncrement;
    if (!Number.isFinite(amount) || amount < needed) {
      return { ok: false, reason: 'TOO_LOW', needed, auction: a };
    }

    a.currentPrice = amount;
    a.leader = bidder;
    a.bidCount += 1;

    let extended = false;
    if (a.endsAt - t <= EXTEND_WINDOW_MS) {
      a.endsAt += EXTEND_BY_MS;
      extended = true;
    }

    a.log.push({ seq: ++this.seq, bidder, amount, at: t });
    return { ok: true, extended, auction: a };
  }

  // Close every auction whose time is up. Returns the ones just closed.
  sweep() {
    const t = this.now();
    const closed = [];
    for (const a of this.auctions.values()) {
      if (a.status === 'open' && t >= a.endsAt && this.close(a.id)) closed.push(a);
    }
    return closed;
  }
}

module.exports = { AuctionStore, EXTEND_WINDOW_MS, EXTEND_BY_MS };
