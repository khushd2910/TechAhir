# HammerTime Live — Design Writeup

**Goal:** support 50,000 auctions running simultaneously, up to 200,000 concurrent viewers per hot auction, with near-real-time price visibility and a guaranteed single winner per auction — even though most bids land in the final ten seconds.

This document summarizes the six scaling decisions. All six are implemented (not mocked) in the running demo project: the Bun auction engine (`mini-services/auction-engine/index.ts`) plus the Next.js realtime frontend.

---

## 1 · Single-writer per auction (sharded write path)

Auctions are partitioned by `auctionId` across stateless **bid-gateway** nodes; consistent hashing routes every command for one auction to exactly one shard owner. Inside the owner, bid commands execute in a **single-threaded critical section** — no `await` between state read and state mutation — which yields a *total order* of bids per auction with zero distributed locks. Ties are impossible by construction: at most one bid can win at any price level, and every accepted bid strictly bumps `version` and `currentPrice`.

*In the demo:* the engine is one shard; `placeBid()` is synchronous by design. The UI's burst test fires 50 same-price bids simultaneously → exactly 1 accepted, 49 rejected.

## 2 · Read/write split and fan-out (the 200k-viewer problem)

Watchers are **pure readers** and never touch the write path. Each viewer joins one room per auction (socket.io) and receives only **delta frames** — price, leader, version, deadline — a few dozen bytes per accepted bid. Snapshots come from read replicas serving pagination/search; everything after that is push. A 200k-viewer auction therefore costs the write path exactly **one broadcast per accepted bid**; the 200k fan-out happens in the transport layer and scales horizontally by adding gateway nodes. Viewer counts are coalesced into 2-second delta frames instead of per-join chatter, and slow consumers drop to snapshot-and-resync rather than queueing unbounded deltas.

*In the demo:* the 24-card grid pages through thousands of lots while updating live; rooms drive per-auction watcher counts.

## 3 · Event-sourced ledger with versioned state

Every accepted bid is an **immutable event** carrying a global sequence number, the resulting state version, bidder identity and idempotency key. State is a pure fold of events, so recovery = replay. In production the log is a partitioned commit log (e.g. Kafka) with periodic snapshots to a durable store; appends are O(1) and history is replayable at any offset for audits, disputes and analytics. Optimistic concurrency on `version` deterministically rejects stale writers.

*In the demo:* the per-auction ring buffer is the audit trail; the bid stream shows monotonic `seq` and `version` values even under load.

## 4 · Timing-wheel deadlines and exactly-once settlement

5,000 live timers would melt `setTimeout` — deadlines live in a **min-heap timing wheel** (hierarchical timing wheel in production), swept every 250 ms. **Anti-snipe** is decided by the single writer: a bid accepted while ≤30 s remains extends the deadline by exactly 30 s and re-registers the heap entry, so extensions only ever push `endsAt` forward. **Settlement** is idempotent: the `live → ended` transition is guarded by status, so the winner is unique whether it is declared by the scheduler, by a lazy read racing ahead of the scheduler, or by both at once.

*In the demo:* a bid 1.5 s before the deadline extended it by exactly 30,000 ms; auctions settle exactly once with a unique winner.

## 5 · Hot-auction protection and backpressure

Most bids arrive in the final ten seconds, so the hot path does constant-time work only: one map lookup, two comparisons, one heap push when extended, one room emit. Admission control layers **rate limits per user and per auction**; an **idempotency-key dedup map** absorbs client retries so network storms cannot double-charge a bidder; read replicas and CDN-cached static assets absorb the viewing storm. Every rejection is an explicit, explained code (`LOW_BID` / `ENDED` / `DUPLICATE` / `STALE_VERSION` / `INVALID`) — the system fails loudly, never ambiguously.

*In the demo:* the Load Test tab drives 3,000+ commands/sec (peaks configurable to 20k) through the same critical section with sub-millisecond write latency.

## 6 · Correctness under concurrency — the invariants

- **Monotonic price:** an accepted bid must exceed `currentPrice + minIncrement`; the price series can never fork or regress.
- **Total order:** concurrent bids are serialized by the shard owner's event loop; "two winners for one price" cannot be constructed.
- **Idempotency:** replayed `requestId`s are detected and rejected (`DUPLICATE`) — safe retries, no double charging.
- **Clock discipline:** deadlines and the final-30 s window are evaluated against **engine time**, not client clocks; clients render countdowns from engine-synced timestamps (skew-corrected).
- **Exactly-once settlement:** status-guarded transition ⇒ one winner per auction, verifiable from the event log.

*In the demo:* every guarantee is testable in the browser — burst test, live extensions, settlement banners.

---

## What is running

| Component | Role |
| --- | --- |
| `mini-services/auction-engine` (Bun, port 3002) | 5,000+ in-memory auctions; single-writer critical section; anti-snipe +30 s soft close; min-heap scheduler; exactly-once settlement; socket.io room fan-out; load-test control plane; marketplace replenisher |
| Next.js UI (port 3000) | Live grid (5,008 lots), auction room (manual bidding, burst correctness test, live bid stream, viewer counts), load-test dashboard (throughput chart, latency), design doc |
| Transport | One multiplexed websocket through the gateway: bid RPCs with acks (write path), room broadcasts (read path), stats/control RPCs |
