'use strict';
// The rules of an auction. Pure state machine: no I/O, no timers.
// Every state change is described by an event (create / bid / close) that is
// written to the WAL. Replaying events with applyEvent() rebuilds the exact
// same state after a restart, without re-running any rules or reading a clock.

const DEFAULTS = { extendWindowMs: 30_000, extendByMs: 30_000, recentKeep: 20, idemKeep: 512 };

// Lowest amount that would be accepted next. Prices never go down, so a bid
// below this value computed from ANY older view of the auction is also
// below the real value: that makes edge pre-rejection safe.
function minNextBid(s) {
  return s.bids === 0 ? s.price : s.price + s.minIncrement;
}

class AuctionBook {
  constructor(opts = {}) {
    this.opt = { ...DEFAULTS, ...opts };
    this.now = opts.now || Date.now;
    this.auctions = new Map();
  }

  get(id) { return this.auctions.get(id); }

  snap(a) {
    return {
      id: a.id, title: a.title, status: a.status,
      price: a.price, startPrice: a.startPrice, minIncrement: a.minIncrement,
      leader: a.leader, bids: a.bids, endsAt: a.endsAt, winner: a.winner, v: a.v
    };
  }

  recent(id) {
    const a = this.auctions.get(id);
    return a ? a.recent.slice().reverse() : [];
  }

  create({ id, title, startPrice = 0, minIncrement = 1, durationMs = 60_000 }) {
    const existing = this.auctions.get(id);
    if (existing) return { ok: false, reason: 'EXISTS', auction: this.snap(existing), events: [] };
    const createdAt = this.now();
    const ev = {
      t: 'c', id, title: title || id, startPrice, minIncrement,
      createdAt, endsAt: createdAt + durationMs
    };
    this._applyCreate(ev);
    return { ok: true, auction: this.snap(this.auctions.get(id)), events: [ev] };
  }

  // Decide one bid. Called one at a time per auction (single owner thread),
  // so the order of calls IS the order of bids. Returns events to persist.
  placeBid({ id, bidder, amount, requestId }) {
    const a = this.auctions.get(id);
    if (!a) return { ok: false, reason: 'NOT_FOUND', events: [] };
    const events = [];
    const t = this.now();

    // Lazy close: a bid can never be accepted after endsAt, even if the
    // scheduler has not fired yet. Close time is endsAt, not "now".
    if (a.status === 'open' && t >= a.endsAt) events.push(this._close(a, a.endsAt));

    // Idempotency first: a retry of a bid that was already accepted gets the
    // same answer ("accepted") even if the auction has closed since.
    if (requestId) {
      const prior = a.idem.get(bidder + '\u0000' + requestId);
      if (prior) return { ok: true, duplicate: true, extended: prior.extended, auction: this.snap(a), events };
    }
    if (a.status === 'closed') return { ok: false, reason: 'CLOSED', auction: this.snap(a), events };

    const needed = minNextBid(a);
    if (!(amount >= needed)) return { ok: false, reason: 'TOO_LOW', needed, auction: this.snap(a), events };

    const extended = a.endsAt - t <= this.opt.extendWindowMs;
    const ev = {
      t: 'b', id, bidder, amount, at: t, n: a.bids + 1,
      endsAt: extended ? a.endsAt + this.opt.extendByMs : a.endsAt,
      rid: requestId || undefined, ext: extended || undefined
    };
    this._applyBid(a, ev);
    events.push(ev);
    return { ok: true, extended, auction: this.snap(a), events };
  }

  // Close exactly once: open -> closed is one-way. Returns the event or null.
  close(id, at) {
    const a = this.auctions.get(id);
    if (!a || a.status !== 'open') return null;
    return this._close(a, at);
  }

  // Rebuild state from a logged event (recovery). No rules, no clock.
  applyEvent(ev) {
    if (ev.t === 'c') {
      if (!this.auctions.has(ev.id)) this._applyCreate(ev);
      return;
    }
    const a = this.auctions.get(ev.id);
    if (!a) return;
    if (ev.t === 'b' && a.status === 'open') this._applyBid(a, ev);
    else if (ev.t === 'x' && a.status === 'open') this._applyClose(a, ev);
  }

  _applyCreate(ev) {
    this.auctions.set(ev.id, {
      id: ev.id, title: ev.title, status: 'open',
      startPrice: ev.startPrice, price: ev.startPrice, minIncrement: ev.minIncrement,
      leader: null, bids: 0, endsAt: ev.endsAt, createdAt: ev.createdAt,
      closedAt: null, winner: null, v: 1,
      recent: [], idem: new Map()
    });
  }

  _applyBid(a, ev) {
    a.price = ev.amount;
    a.leader = ev.bidder;
    a.bids = ev.n;
    a.endsAt = ev.endsAt;
    a.recent.push({ bidder: ev.bidder, amount: ev.amount, at: ev.at });
    if (a.recent.length > this.opt.recentKeep) a.recent.shift();
    if (ev.rid) {
      a.idem.set(ev.bidder + '\u0000' + ev.rid, { extended: !!ev.ext });
      if (a.idem.size > this.opt.idemKeep) a.idem.delete(a.idem.keys().next().value);
    }
    a.v++;
  }

  _close(a, at) {
    const ev = {
      t: 'x', id: a.id, at,
      winner: a.leader ? { bidder: a.leader, amount: a.price } : null
    };
    this._applyClose(a, ev);
    return ev;
  }

  _applyClose(a, ev) {
    a.status = 'closed';
    a.closedAt = ev.at;
    a.winner = ev.winner;
    a.v++;
  }
}

module.exports = { AuctionBook, minNextBid };
