# Live Auction Platform

Thousands of auctions running at once, many people watching each one live, and exactly one winner per auction.

## Run it
    npm install
    npm run dev          # http://localhost:3000  (30s rules shortened to 5s so you can see extensions fast)
    npm start            # the real rules: a bid in the last 30s extends by 30s
    npm test             # 21 tests

Open the page, click **Add 2,000 auctions**, pick one, and place bids from two browser tabs.
Set `ADMIN_KEY=secret` to protect creating auctions (send header `x-admin-key`).

## How it works
    browsers --SSE/HTTP--> GATEWAY (Express)                         SHARDS (worker threads)
                           - catalog of every auction (read model)   - own auctions by hash(id)
                           - SSE fan-out, conflated, backpressure    - decide bids one at a time
                           - validation, rate limits, edge reject    - close timers (min-heap)
                           - routes each bid to its shard  -------->  - write-ahead log (group commit)
                           <------ coalesced snapshots, after fsync --

- **One owner per auction** gives one order of bids with no locks.
- **Write-ahead log**: a bid is acknowledged and broadcast only after it is on disk. Restart = replay.
- **Idempotency**: send `Idempotency-Key` (the UI does) and a retried bid counts once, even across a restart.
- **Late bid rule**: if a bid arrives with 30s or less left, the end moves 30s later. A bid after the end is always refused.
- **Exactly one winner**: closing is a one-way state change; the winner is the highest bid (earliest wins a tie).

## API
| Method and path | What it does |
|---|---|
| `GET /api/auctions?status=open&sort=ending&q=&limit=24&offset=0` | Lobby list (sort: `ending`, `hot`, `price`) |
| `GET /api/auctions/:id` | Current state |
| `GET /api/auctions/:id/bids` | Last 20 accepted bids |
| `POST /api/auctions/:id/bids` | `{ "bidder": "ana", "amount": 150 }` plus optional `Idempotency-Key` header |
| `GET /api/stream?ids=a,b,c` | Live updates (SSE) for up to 100 auctions on one connection |
| `POST /api/auctions` | Create `{ id?, title?, startPrice?, minIncrement?, durationMs? }` |
| `POST /api/admin/seed` | Create many `{ count, prefix, minDurationMs, maxDurationMs }` |
| `GET /api/metrics`, `GET /healthz` | Counters, latency, per-shard stats |

Bid responses: `200 {accepted:true, extended}` or `409 {accepted:false, reason: TOO_LOW | CLOSED}`; also `404`, `429` (rate limited), `400`, `503` (shard restarting; retry with the same key). Amounts are whole numbers (use the smallest currency unit).

## Configuration (environment variables)
| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `SHARDS` | 2 to 4 (by CPUs) | Number of shard worker threads |
| `DATA_DIR` | `./data` | Where the write-ahead logs live |
| `WAL_FSYNC` | on | Set `0` to skip fsync (faster, not crash-safe) |
| `EXTEND_WINDOW_MS`, `EXTEND_BY_MS` | 30000 | The late-bid rule |
| `FLUSH_MS` | 100 | Max one update per auction per interval |
| `BIDDER_PER_SEC`, `BIDDER_BURST` | 10, 20 | Per-bidder rate limit |
| `IP_PER_SEC`, `IP_BURST` | 1000, 2000 | Per-IP rate limit |
| `ADMIN_KEY` | none | Protects create and seed |

## Load test
Start the server with relaxed limits and a short extension, then run the script in another terminal:

    BIDDER_PER_SEC=100000 BIDDER_BURST=100000 IP_PER_SEC=1000000 IP_BURST=1000000 \
    EXTEND_WINDOW_MS=3000 EXTEND_BY_MS=3000 npm start
    npm run load -- --auctions=5000 --watchers=2000 --bidders=100 --seconds=10

It seeds the auctions, connects the watchers to one hot auction, hammers it with bids, then checks:
one winner, winner = highest accepted bid, and every watcher saw the same result.

Sample run (1 CPU core shared by server, 2,000 simulated watchers and the load generator, so treat the speed as a floor, not a benchmark): 5,000 auctions created in 111 ms; 2,000 watchers each received about 124 updates; 3,000 bids with all correctness checks passing.

## Project layout
    src/core/        auction rules, min-heap, close scheduler, rate limiter, hash routing (no I/O)
    src/shard/       worker thread, write-ahead log, shard pool with auto-restart
    src/gateway/     Express routes, SSE hub (catalog + fan-out), metrics
    public/          lobby and bid panel
    scripts/         load test and correctness check
    test/            unit, WAL, and end-to-end tests (restart, crash, concurrency)
    DESIGN_NOTE.md   the scaling write-up for the assessment

## Not included (and what to add)
Authentication and payments, a replicated log with standby shards, pub/sub between several gateways, and log compaction/snapshots for very long histories. `DESIGN_NOTE.md` says how each fits in.
