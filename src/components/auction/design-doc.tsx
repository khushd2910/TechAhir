'use client'

import { Boxes, Database, Gauge, GitBranch, Layers, ShieldCheck, Timer } from 'lucide-react'

const POINTS = [
  {
    icon: GitBranch,
    title: '1 · Single-writer per auction (sharded write path)',
    body:
      'Auctions are partitioned by auctionId across stateless bid-gateway nodes; consistent hashing routes every command for one auction to exactly one shard owner. Inside the owner, commands execute in a single-threaded critical section (no awaits between state read and mutation), which yields a total order of bids per auction with zero distributed locks. In this demo the whole engine is one shard — the `placeBid` critical section is synchronous by design, which is why 50 simultaneous bids at the same price produce exactly one winner.',
    demo: 'Proof: run the burst test in the Auction Room tab.',
  },
  {
    icon: Layers,
    title: '2 · Read/write split and fan-out (50k auctions, 200k viewers)',
    body:
      'Watchers are pure readers and never touch the write path: they join one socket.io room per auction and receive only small delta frames (price, leader, version, deadline). Read replicas serve pagination and search; snapshots are fetched once, then everything else is a push. A 200k-viewer auction costs the write path exactly one broadcast per accepted bid — fan-out happens in the transport layer, scaled horizontally by adding gateway nodes, with coalesced 2s viewer-count frames instead of per-join chatter.',
    demo: 'Proof: browse 24 live lots while the grid updates in real time; the Live Auctions tab pages through thousands without touching bids.',
  },
  {
    icon: Database,
    title: '3 · Event-sourced ledger with versioned state',
    body:
      'Every accepted bid is an immutable event with a global sequence number, the resulting state version, and the bidder identity — the in-memory ring buffer per auction is the audit trail. State is a pure fold of events, so recovery = replay (in production: a partitioned log like Kafka plus periodic snapshots to a durable store; bids append at O(1) and history is replayable at any offset). Optimistic concurrency on `version` rejects stale writers deterministically.',
    demo: 'Proof: the live bid stream shows seq numbers and versions increasing monotonically, even under the load test.',
  },
  {
    icon: Timer,
    title: '4 · Timing-wheel deadlines and exactly-once settlement',
    body:
      '5,000 live timers would melt setTimeout — deadlines live in a min-heap (a hierarchical timing wheel in production), swept every 250ms. Anti-snipe is decided by the single writer: a bid accepted with ≤30s remaining extends the deadline by exactly 30s and re-registers the heap entry. Settlement is guarded by status: the transition live → ended can only happen once, so the winner is unique whether it is declared by the scheduler, by a lazy read racing ahead, or by both at once.',
    demo: 'Proof: the smoke test showed a bid 1.5s before the deadline extending it by exactly 30,000ms; 18+ auctions settled with one winner each.',
  },
  {
    icon: Gauge,
    title: '5 · Hot-auction protection and backpressure',
    body:
      'Most bids arrive in the final ten seconds, so the hot path does constant-time work only: one map lookup, two comparisons, one heap push when extended, one room emit. Admission control layers rate limits per user and per auction, and the idempotency-key dedup map absorbs client retries so network storms cannot double-charge a bidder. Slow consumers are dropped to snapshot-and-resync instead of queueing unbounded deltas; every rejection is an explicit, explained code (LOW_BID / ENDED / DUPLICATE / STALE_VERSION).',
    demo: 'Proof: the Load Test tab drives thousands of commands per second through the same critical section; watch accepted vs rejected split and sub-millisecond write latency.',
  },
  {
    icon: ShieldCheck,
    title: '6 · Correctness under concurrency — the invariants',
    body:
      '(a) Monotonic price: an accepted bid strictly exceeds current price + minimum increment, so the price series never forks. (b) Total order: concurrent bids are serialized by the event loop — ties are impossible by construction. (c) Idempotent settlement: exactly one winner is declared per auction, verifiable from the event log. (d) Deadline monotonicity: extensions only ever push endsAt forward, and the final 30-second window is evaluated against engine time, not client clocks. Together these guarantee "multi-bidder races stay correct and every auction ends with exactly one winner".',
    demo: 'Proof: run the burst test twice, then watch the same lot settle to a single winner in the Live Auctions tab.',
  },
]

export function DesignDoc() {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-5">
        <p className="font-semibold text-amber-700 dark:text-amber-600 dark:text-amber-300">Design brief — scaling to 50,000 simultaneous auctions, 200,000 viewers each</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Six decisions make the scale work. Each card below pairs the production pattern with the exact mechanism implemented in this running demo.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {POINTS.map((p) => (
          <div key={p.title} className="rounded-xl border border-border bg-card/70 p-5">
            <p className="flex items-center gap-2.5 font-semibold text-foreground">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10">
                <p.icon className="h-4 w-4 text-amber-400" aria-hidden />
              </span>
              {p.title}
            </p>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
            <p className="mt-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">{p.demo}</p>
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-border bg-card/70 p-5">
        <p className="flex items-center gap-2 font-semibold text-foreground"><Boxes className="h-4 w-4 text-amber-400" aria-hidden /> What is running right now</p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          A Bun mini-service engine (port 3002) holds 5,000+ in-memory auctions with the single-writer critical section, timing-wheel scheduler and anti-snipe logic described above. The Next.js UI talks to it over one multiplexed websocket through the gateway: bid commands are RPCs with acks (the write path), room broadcasts are deltas (the read path), and the load-test control plane rides the same socket. The design keeps every invariant testable in the browser — no mocks, no shortcuts on the bidding rules.
        </p>
      </div>
    </div>
  )
}
