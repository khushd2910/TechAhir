# Design note: 50,000 auctions at once, up to 200,000 watchers on one

1. **One owner per auction, so bids have one order.** Auctions are partitioned by `hash(auctionId)` across shards. Each auction lives on exactly one shard, and that shard handles its bids one at a time. The order bids arrive in is the order they win in, with no distributed locks. "Exactly one winner" is a single one-way `open -> closed` transition made by that owner. Ties go to the earliest arrival because a bid must beat the price, not match it.

2. **Bidding is a tiny in-memory step, made durable with group commit.** A bid is validated, compared with the price, applied, and extended if it lands in the last 30 seconds. Every accepted bid is appended to a write-ahead log, and many bids share one fsync. A bid is acknowledged, and shown to watchers, only after it is on disk, so no watcher ever sees a bid that could be lost. After a crash the shard replays its log and ends up in the exact same state. Retries carry an idempotency key, so a repeated request can never count as two bids.

3. **Watching is a separate, horizontally scaled tier.** Watchers connect to stateless gateway nodes over SSE or WebSocket, never to the bid owners. Owners publish state changes to a pub/sub channel (in-process here, Redis or NATS in production), and each gateway subscribes only to the auctions its watchers follow. Reads (lobby, auction page, first snapshot) are served from the gateway's memory, so the shards only do bidding. Capacity is added by adding gateways: 200,000 watchers is about 20 gateways at 10,000 connections each.

4. **The last ten seconds are handled by conflation, not by sending every bid.** Updates are full snapshots, not deltas. An owner sends at most one update per auction every 100ms, so 5,000 bids in a second become 10 messages per watcher. The JSON is built once and the same string is written to every watcher. A watcher with a full socket buffer is skipped (the next snapshot carries the latest state anyway) and dropped if it stays behind. Late-bid extensions and the final result bypass the timer and go out immediately.

5. **Time has one authority, and closing never scans.** The server owns `endsAt`. Clients only show a countdown and correct their clock from the server time in each update. Closing uses a min-heap with one timer for the earliest deadline, so 50,000 auctions cost `O(log n)` per close instead of polling every auction. A bid arriving after `endsAt` is refused even if the timer has not fired yet, so nobody wins "in the last instant".

6. **Failure and hot-spot handling.** A crashed shard is restarted from its log; auctions that ended while it was down are closed at their original `endsAt`. In production each shard has a replica that tails the log and takes over. Bids that are already too low are rejected at the edge (prices never go down, so this is always safe), and per-bidder and per-IP token buckets protect the owner during the final-seconds burst. One hot auction is capped by one core, which is far above real bid rates; if it ever were not, bids for it can be batched in a queue in front of the owner.

## Capacity back-of-envelope
- Owner: a bid costs a few microseconds of CPU; one shard can decide tens of thousands of bids per second. 50,000 auctions over 16 shards is about 3,100 per shard, held in roughly 1 KB each.
- Fan-out: 200,000 watchers x 10 updates/s x ~250 bytes is about 500 MB/s in total, spread over ~20 gateways (about 25 MB/s each). Raising the update interval to 250ms when a room is huge cuts this by 2.5x.

## What is implemented vs only designed
| Piece | In this repo | In production |
|---|---|---|
| Shard ownership, ordering, one winner | Worker threads, real | Processes on many machines, same routing |
| Durability, recovery, idempotency | WAL with group commit, replay, torn-tail repair | Replicated log (Kafka or similar) with standby takeover |
| Fan-out | One gateway process, SSE, conflation, backpressure | Many gateways + Redis/NATS pub/sub |
| Close scheduling | Min-heap, one timer | Same, per shard |
| Abuse protection | Token buckets, edge rejection | Plus auth, WAF, per-auction queues |
