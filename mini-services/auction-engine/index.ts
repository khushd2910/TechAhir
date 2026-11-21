/**
 * LIVE AUCTION ENGINE  (mini-service, port 3002)
 *
 * Architecture (mirrors production design):
 *  - Single-writer core: every bid command is executed synchronously inside one
 *    event-loop turn (no `await` inside the critical section). Node/Bun's single
 *    threaded execution therefore gives a TOTAL ORDER of bids per auction
 *    without distributed locks. In production this is the "one shard owner per
 *    auctionId" pattern; here the whole engine is one shard.
 *  - Optimistic concurrency: each mutation bumps `version`; clients that replay
 *    a stale command get a stale-version rejection.
 *  - Idempotency: every bid carries a requestId; replays are deduplicated.
 *  - Anti-snipe: a bid accepted while remaining time <= 30s extends the deadline
 *    by 30s (soft close, recorded as an explicit extension event).
 *  - Settlement: proactive min-heap deadline scheduler + lazy settle-on-read;
 *    the status guard makes the transition exactly-once => a UNIQUE winner.
 *  - Fan-out: socket.io room per auction. Watchers are pure readers and never
 *    touch the write path. Viewer counts are derived from room membership.
 */
import { createServer } from 'http'
import { Server } from 'socket.io'

// ---------------------------------------------------------------- constants
const PORT = 3002
const ANTI_SNIPE_MS = 30_000 // bids in the final 30s extend the deadline by 30s
const TICK_MS = 250 // deadline scheduler resolution
const SEED_AUCTIONS = 5_000
const HOT_AUCTIONS = 8
const MAX_BID_HISTORY = 60
const MAX_DEDUP_ENTRIES = 200_000
const VIEWER_BROADCAST_MS = 2_000
const MAX_LIVE_AGE_MS = 90 * 60_000 // auctions older than this are retired from listings

// ---------------------------------------------------------------- types
type AuctionStatus = 'live' | 'ended'
type RejectCode =
  | 'NOT_FOUND' | 'ENDED' | 'LOW_BID' | 'STALE_VERSION' | 'DUPLICATE' | 'INVALID'

interface BidEvent {
  seq: number
  auctionId: string
  userId: string
  userName: string
  amount: number
  at: number
  version: number
  requestId: string
  extended: boolean
}

interface Auction {
  id: string
  title: string
  category: string
  hot: boolean
  startPrice: number
  minIncrement: number
  currentPrice: number
  leaderId: string | null
  leaderName: string | null
  bidCount: number
  extensionCount: number
  version: number
  status: AuctionStatus
  endsAt: number
  createdAt: number
  settledAt: number | null
  winnerId: string | null
  winnerName: string | null
  finalPrice: number | null
  bids: BidEvent[] // ring buffer of recent accepted bids (audit trail)
}

interface BidCommand {
  auctionId: string
  userId: string
  userName?: string
  amount: number
  requestId: string
  clientVersion?: number
}

interface BidResult {
  accepted: boolean
  code: 'ACCEPTED' | RejectCode
  auctionId: string
  price?: number
  minRequired?: number
  version?: number
  endsAt?: number
  extended?: boolean
  leader?: { userId: string; userName: string } | null
  seq?: number
  serverNow: number
  reason?: string
}

// ---------------------------------------------------------------- state
const auctions = new Map<string, Auction>()
const liveIds = new Set<string>() // index of live auction ids (fast sampling)
const dedup = new Map<string, string>() // requestId -> auctionId
const deadlineHeap: Array<{ endsAt: number; id: string }> = [] // min-heap by endsAt
let globalSeq = 0

const stats = {
  startedAt: Date.now(),
  bidsAccepted: 0,
  bidsRejected: 0,
  rejections: {} as Record<string, number>,
  extensions: 0,
  settled: 0,
  peakBidsPerSec: 0,
  wsClients: 0,
}

// rolling per-second throughput (last 120s)
const throughput: Array<{ ts: number; accepted: number; rejected: number }> = []
let secAccepted = 0
let secRejected = 0
let secStarted = Date.now()

// ---------------------------------------------------------------- heap utils
function heapPush(item: { endsAt: number; id: string }) {
  deadlineHeap.push(item)
  let i = deadlineHeap.length - 1
  while (i > 0) {
    const p = (i - 1) >> 1
    if (deadlineHeap[p].endsAt <= deadlineHeap[i].endsAt) break
    ;[deadlineHeap[p], deadlineHeap[i]] = [deadlineHeap[i], deadlineHeap[p]]
    i = p
  }
}
function heapPop(): { endsAt: number; id: string } | undefined {
  if (deadlineHeap.length === 0) return undefined
  const top = deadlineHeap[0]
  const last = deadlineHeap.pop()!
  if (deadlineHeap.length > 0) {
    deadlineHeap[0] = last
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      if (l < deadlineHeap.length && deadlineHeap[l].endsAt < deadlineHeap[m].endsAt) m = l
      if (r < deadlineHeap.length && deadlineHeap[r].endsAt < deadlineHeap[m].endsAt) m = r
      if (m === i) break
      ;[deadlineHeap[m], deadlineHeap[i]] = [deadlineHeap[i], deadlineHeap[m]]
      i = m
    }
  }
  return top
}

// ---------------------------------------------------------------- write path
/**
 * CRITICAL SECTION — synchronous by design. No await between the state read
 * and the state mutation, so concurrent commands are serialized by the event
 * loop in arrival order: at most ONE bid can win at a given price and every
 * accepted bid strictly increases `version` and `currentPrice`.
 */
function placeBid(cmd: BidCommand): BidResult {
  const now = Date.now()
  const { auctionId, userId, amount, requestId } = cmd
  const reject = (code: RejectCode, extra?: Partial<BidResult>): BidResult => {
    stats.bidsRejected++
    secRejected++
    stats.rejections[code] = (stats.rejections[code] || 0) + 1
    return { accepted: false, code, auctionId, serverNow: now, ...extra }
  }

  if (!auctionId || !userId || !Number.isFinite(amount) || amount <= 0 || !requestId)
    return reject('INVALID', { reason: 'malformed bid command' })

  const a = auctions.get(auctionId)
  if (!a) return reject('NOT_FOUND')

  // idempotency: a retried request must not double-charge a bidder
  if (dedup.has(requestId)) return reject('DUPLICATE')

  if (a.status !== 'live') return reject('ENDED')
  if (now >= a.endsAt) {
    settle(a, now) // lazy settle: the deadline passed between scheduler ticks
    return reject('ENDED')
  }
  if (typeof cmd.clientVersion === 'number' && cmd.clientVersion < a.version)
    return reject('STALE_VERSION', { version: a.version })

  const minRequired = a.currentPrice + a.minIncrement
  if (amount < minRequired) return reject('LOW_BID', { minRequired })

  // ---- ACCEPT ----
  const remaining = a.endsAt - now
  let extended = false
  if (remaining <= ANTI_SNIPE_MS) {
    a.endsAt = a.endsAt + ANTI_SNIPE_MS // soft close: +30s
    a.extensionCount++
    stats.extensions++
    extended = true
    heapPush({ endsAt: a.endsAt, id: a.id }) // re-register new deadline
  }

  a.currentPrice = amount
  a.leaderId = userId
  a.leaderName = cmd.userName || `Bidder-${userId.slice(-4)}`
  a.bidCount++
  a.version++
  const seq = ++globalSeq

  const ev: BidEvent = {
    seq, auctionId, userId, userName: a.leaderName, amount,
    at: now, version: a.version, requestId, extended,
  }
  a.bids.push(ev)
  if (a.bids.length > MAX_BID_HISTORY) a.bids.shift()

  dedup.set(requestId, auctionId)
  if (dedup.size > MAX_DEDUP_ENTRIES) {
    // evict oldest 20% (Map preserves insertion order)
    let n = Math.floor(MAX_DEDUP_ENTRIES * 0.2)
    for (const k of dedup.keys()) { dedup.delete(k); if (--n === 0) break }
  }

  stats.bidsAccepted++
  secAccepted++
  const result: BidResult = {
    accepted: true, code: 'ACCEPTED', auctionId,
    price: a.currentPrice, version: a.version, endsAt: a.endsAt,
    extended, leader: { userId, userName: a.leaderName }, seq, serverNow: now,
  }

  // fan-out to room subscribers (viewers never hit the write path)
  io.to(roomName(auctionId)).emit('auction:bid', {
    auctionId, price: a.currentPrice, leaderId: a.leaderId, leaderName: a.leaderName,
    bidCount: a.bidCount, version: a.version, endsAt: a.endsAt,
    extended, seq, at: now, userName: a.leaderName,
  })
  if (extended) {
    io.to(roomName(auctionId)).emit('auction:extended', {
      auctionId, endsAt: a.endsAt, extensionCount: a.extensionCount, by: a.leaderName, at: now,
    })
  }
  return result
}

/**
 * Settlement — exactly-once. The `status !== 'live'` guard makes it idempotent
 * even if both the scheduler and a lazy read race to settle the same auction.
 */
function settle(a: Auction, now: number): void {
  if (a.status !== 'live') return
  a.status = 'ended'
  a.settledAt = now
  a.winnerId = a.leaderId
  a.winnerName = a.leaderName
  a.finalPrice = a.currentPrice
  a.version++
  liveIds.delete(a.id)
  stats.settled++
  io.to(roomName(a.id)).emit('auction:ended', {
    auctionId: a.id,
    winnerId: a.winnerId,
    winnerName: a.winnerName,
    finalPrice: a.finalPrice,
    bidCount: a.bidCount,
    settledAt: now,
    title: a.title,
  })
}

// proactive deadline scheduler (timing-wheel style min-heap sweep)
setInterval(() => {
  const now = Date.now()
  for (;;) {
    const top = deadlineHeap[0]
    if (!top || top.endsAt > now) break
    heapPop()
    const a = auctions.get(top.id)
    if (!a || a.status !== 'live') continue
    if (a.endsAt !== top.endsAt) continue // stale heap entry (auction was extended)
    settle(a, now)
  }
}, TICK_MS)

// ---------------------------------------------------------------- throughput
setInterval(() => {
  const now = Date.now()
  if (now - secStarted >= 1000) {
    const perSec = (secAccepted / ((now - secStarted) / 1000)) | 0
    throughput.push({ ts: secStarted, accepted: secAccepted, rejected: secRejected })
    if (throughput.length > 120) throughput.shift()
    stats.peakBidsPerSec = Math.max(stats.peakBidsPerSec, perSec)
    secAccepted = 0
    secRejected = 0
    secStarted = now
  }
}, 200)

// ---------------------------------------------------------------- seeding
const ADJ = ['Vintage', 'Rare', 'Antique', 'Limited', 'Signed', 'Authentic', 'Prototype', 'Collector', 'Handmade', 'Legendary']
const ITEMS = ['Rolex Submariner', 'Gibson Les Paul', 'Basquiat Sketch', '1st Edition Dr. Seuss', 'Fender Stratocaster', 'Cartier Bracelet', 'Michael Jordan Jersey', 'Picasso Lithograph', 'Tesla Roadster Slot', 'Japanese Katana', 'Roman Coin Set', 'Hermes Birkin Bag', 'Beatles Vinyl', 'Gemstone Necklace', 'Retro Arcade Cabinet']
const CATEGORIES = ['Watches', 'Art', 'Music', 'Sports', 'Jewelry', 'Collectibles', 'Fashion', 'Vehicles']

function seedAuction(i: number, endsAt: number, hot: boolean): Auction {
  const startPrice = hot ? 500 + ((i * 977) % 5000) : 10 + ((i * 7919) % 4000)
  const id = hot ? `hot-${i}` : `a-${i}`
  const a: Auction = {
    id,
    title: `${ADJ[i % ADJ.length]} ${ITEMS[i % ITEMS.length]} ${hot ? '' : '#' + (1000 + i)}`,
    category: CATEGORIES[i % CATEGORIES.length],
    hot,
    startPrice,
    minIncrement: Math.max(1, Math.round(startPrice * 0.02)),
    currentPrice: startPrice,
    leaderId: null, leaderName: null,
    bidCount: 0, extensionCount: 0, version: 1,
    status: 'live',
    endsAt, createdAt: Date.now(),
    settledAt: null, winnerId: null, winnerName: null, finalPrice: null,
    bids: [],
  }
  auctions.set(id, a)
  liveIds.add(id)
  heapPush({ endsAt, id })
  return a
}

function seed(): void {
  const now = Date.now()
  for (let i = 0; i < SEED_AUCTIONS; i++) {
    seedAuction(i, now + 60_000 + Math.random() * 24 * 60_000, false)
  }
  for (let i = 0; i < HOT_AUCTIONS; i++) {
    seedAuction(i, now + 35_000 + i * 12_000, true)
  }
  console.log(`[engine] seeded ${auctions.size} auctions`)
}
seed()

// marketplace replenisher: a real platform gets new listings continuously;
// keep the live catalog near SEED_AUCTIONS so the demo never runs dry
let topUpSeq = 0
setInterval(() => {
  const deficit = SEED_AUCTIONS - liveIds.size - 250 // keep a small headroom buffer
  if (deficit < 100) return
  const now = Date.now()
  const batch = Math.min(deficit, 1000)
  const base = `r${Date.now().toString(36)}`
  for (let i = 0; i < batch; i++) {
    const idx = (topUpSeq++ + i) % ITEMS.length
    const a: Auction = {
      id: `${base}-${i}`,
      title: `${ADJ[idx % ADJ.length]} ${ITEMS[idx]} #${100000 + topUpSeq + i}`,
      category: CATEGORIES[idx % CATEGORIES.length],
      hot: false,
      startPrice: 10 + Math.floor(Math.random() * 4000),
      minIncrement: 20,
      currentPrice: 0, // set below
      leaderId: null, leaderName: null,
      bidCount: 0, extensionCount: 0, version: 1,
      status: 'live',
      endsAt: now + 60_000 + Math.random() * 24 * 60_000,
      createdAt: now,
      settledAt: null, winnerId: null, winnerName: null, finalPrice: null,
      bids: [],
    }
    a.currentPrice = a.startPrice
    auctions.set(a.id, a)
    liveIds.add(a.id)
    heapPush({ endsAt: a.endsAt, id: a.id })
  }
  console.log(`[engine] topped up ${batch} new lots (live: ${liveIds.size})`)
}, 30_000)

// ---------------------------------------------------------------- load test
interface LoadTestConfig {
  targetBps: number // total bid commands per second
  hotShare: number // 0..1 fraction of traffic aimed at hot auctions
  durationSec: number
}
interface LoadTestState {
  running: boolean
  config: LoadTestConfig
  startedAt: number | null
  commands: number
  accepted: number
  rejected: number
  extensions: number
  settled: number
  maxLatencyMs: number
  avgLatencyMs: number
  timer: ReturnType<typeof setInterval> | null
}
const load: LoadTestState = {
  running: false,
  config: { targetBps: 2000, hotShare: 0.4, durationSec: 30 },
  startedAt: null, commands: 0, accepted: 0, rejected: 0,
  extensions: 0, settled: 0, maxLatencyMs: 0, avgLatencyMs: 0, timer: null,
}

let botSeq = 0
function runLoadTick(): void {
  const step = 100 // ms
  const perTick = Math.max(1, Math.round((load.config.targetBps * step) / 1000))
  const liveArr = Array.from(liveIds)
  if (liveArr.length === 0) return
  const hotArr = liveArr.filter((id) => auctions.get(id)?.hot)
  for (let i = 0; i < perTick; i++) {
    const useHot = hotArr.length > 0 && Math.random() < load.config.hotShare
    const pool = useHot ? hotArr : liveArr
    const auctionId = pool[Math.floor(Math.random() * pool.length)]
    const a = auctions.get(auctionId)
    if (!a || a.status !== 'live') continue
    const lowball = Math.random() < 0.25 // 25% deliberately under-bid -> admission control rejects
    const amount = lowball
      ? a.currentPrice
      : a.currentPrice + a.minIncrement * (1 + Math.floor(Math.random() * 5))
    const cmd: BidCommand = {
      auctionId,
      userId: `bot-${botSeq++}`,
      userName: `Bot #${(botSeq % 9999) + 1}`,
      amount,
      requestId: `load-${botSeq}-${Date.now()}`,
    }
    const t0 = performance.now()
    const r = placeBid(cmd)
    const dt = performance.now() - t0
    load.commands++
    if (r.accepted) {
      load.accepted++
      if (r.extended) load.extensions++
    } else load.rejected++
    load.avgLatencyMs = load.avgLatencyMs * 0.95 + dt * 0.05
    load.maxLatencyMs = Math.max(load.maxLatencyMs, dt)
  }
}

function startLoad(config: Partial<LoadTestConfig>): void {
  if (load.running) stopLoad()
  load.config = { ...load.config, ...config }
  load.running = true
  load.startedAt = Date.now()
  load.commands = 0; load.accepted = 0; load.rejected = 0
  load.extensions = 0; load.settled = 0; load.maxLatencyMs = 0; load.avgLatencyMs = 0
  // pull hot auctions near their deadline so anti-snipe storms trigger
  const now = Date.now()
  for (const id of Array.from(liveIds)) {
    const a = auctions.get(id)
    if (a?.hot) {
      a.endsAt = now + 40_000 + Math.random() * 40_000
      heapPush({ endsAt: a.endsAt, id })
    }
  }
  load.timer = setInterval(runLoadTick, 100)
  console.log(`[load] started: ${JSON.stringify(load.config)}`)
}
function stopLoad(): void {
  if (load.timer) clearInterval(load.timer)
  load.timer = null
  load.running = false
  console.log(`[load] stopped: ${load.accepted} accepted / ${load.rejected} rejected`)
}

setInterval(() => {
  if (load.running && load.startedAt && Date.now() - load.startedAt > load.config.durationSec * 1000) stopLoad()
}, 500)

// ---------------------------------------------------------------- socket.io
// NOTE: socket.io owns path "/" (Caddy gateway requirement), so the engine
// exposes its read/control surface as RPC-over-websocket with acks instead of
// REST. One multiplexed connection carries snapshots AND live deltas — mirrors
// the production read path where viewers never touch an HTTP backend.
const httpServer = createServer()

const io = new Server(httpServer, {
  path: '/', // forwarded by the Caddy gateway — DO NOT change
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

const roomName = (id: string) => `auction:${id}`
const watchedBy = new Map<string, Set<string>>() // socketId -> auctionIds

function summary(a: Auction) {
  return {
    id: a.id, title: a.title, category: a.category, hot: a.hot,
    currentPrice: a.currentPrice, startPrice: a.startPrice,
    minIncrement: a.minIncrement, leaderId: a.leaderId, leaderName: a.leaderName,
    bidCount: a.bidCount, extensionCount: a.extensionCount, version: a.version,
    status: a.status, endsAt: a.endsAt, settledAt: a.settledAt,
    winnerId: a.winnerId, winnerName: a.winnerName, finalPrice: a.finalPrice,
  }
}

interface ListQuery {
  page?: number
  limit?: number
  q?: string
  status?: 'live' | 'ended' | 'all'
  category?: string
  sort?: 'ending' | 'bids'
}

function listAuctions(q: ListQuery): Record<string, unknown> {
  const now = Date.now()
  const page = Math.max(1, q.page || 1)
  const limit = Math.min(60, Math.max(1, q.limit || 24))
  const term = (q.q || '').toLowerCase()
  const status = q.status || 'live'
  let pool: Auction[] = []
  for (const a of auctions.values()) {
    if (now - a.createdAt > MAX_LIVE_AGE_MS) continue
    if (status === 'live' && a.status !== 'live') continue
    if (status === 'ended' && a.status !== 'ended') continue
    if (term && !a.title.toLowerCase().includes(term)) continue
    if (q.category && a.category !== q.category) continue
    pool.push(a)
    if (pool.length > 50_000) break
  }
  if (q.sort === 'bids') pool.sort((x, y) => y.bidCount - x.bidCount)
  else pool.sort((x, y) => (Number(y.hot) - Number(x.hot)) || (x.endsAt - y.endsAt))
  const start = (page - 1) * limit
  return { auctions: pool.slice(start, start + limit).map(summary), total: pool.length, page, limit, serverNow: now }
}

io.on('connection', (socket) => {
  stats.wsClients++
  watchedBy.set(socket.id, new Set())

  // ---- subscriptions (room joins; viewer = pure reader) ----
  socket.on('watch', (ids: string[], ack?: (d: unknown) => void) => {
    const mine = watchedBy.get(socket.id)!
    const summaries: Array<Record<string, unknown>> = []
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, 60)) {
      if (!mine.has(id)) { mine.add(id); socket.join(roomName(id)) }
      const a = auctions.get(id)
      if (a) summaries.push({ ...summary(a), recentBids: a.bids.slice(-15) })
    }
    ack?.({ ok: true, auctions: summaries, serverNow: Date.now() })
  })
  socket.on('unwatch', (ids: string[]) => {
    const mine = watchedBy.get(socket.id)!
    for (const id of (Array.isArray(ids) ? ids : [])) {
      mine.delete(id)
      socket.leave(roomName(id))
    }
  })
  socket.on('disconnect', () => {
    stats.wsClients--
    watchedBy.delete(socket.id)
  })
  socket.on('error', (e) => console.error(`[ws] ${socket.id}`, e))

  // ---- RPC: write path (single-writer critical section) ----
  socket.on('bid', (cmd: BidCommand, ack?: (r: BidResult) => void) => {
    ack?.(placeBid(cmd))
  })

  // ---- RPC: read path (snapshots; deltas arrive via room broadcasts) ----
  socket.on('auction:list', (q: ListQuery, ack?: (d: unknown) => void) => ack?.(listAuctions(q)))
  socket.on('auction:get', ({ id }: { id: string }, ack?: (d: unknown) => void) => {
    const a = auctions.get(id)
    if (!a) return ack?.({ ok: false, error: 'NOT_FOUND', serverNow: Date.now() })
    ack?.({ ok: true, auction: { ...summary(a), recentBids: a.bids.slice(-30) }, serverNow: Date.now() })
  })
  socket.on('auction:stats', (...args: unknown[]) => {
    const ack = args.find((a) => typeof a === 'function') as ((d: unknown) => void) | undefined
    ack?.({
      ...stats,
      liveAuctions: liveIds.size,
      totalAuctions: auctions.size,
      globalSeq,
      serverNow: Date.now(),
      uptimeMs: Date.now() - stats.startedAt,
      load: { running: load.running, config: load.config, startedAt: load.startedAt,
        commands: load.commands, accepted: load.accepted, rejected: load.rejected,
        extensions: load.extensions, settled: load.settled,
        avgLatencyMs: +load.avgLatencyMs.toFixed(3), maxLatencyMs: +load.maxLatencyMs.toFixed(3) },
      throughput,
    })
  })

  // ---- RPC: load-test control plane ----
  socket.on('load:start', (cfg: Partial<LoadTestConfig>, ack?: (d: unknown) => void) => {
    startLoad(cfg || {})
    ack?.({ ok: true, config: load.config, serverNow: Date.now() })
  })
  socket.on('load:stop', (...args: unknown[]) => {
    const ack = args.find((a) => typeof a === 'function') as ((d: unknown) => void) | undefined
    stopLoad()
    ack?.({ ok: true, serverNow: Date.now() })
  })
  socket.on('load:hot', (...args: unknown[]) => {
    const ack = args.find((a) => typeof a === 'function') as ((d: unknown) => void) | undefined
    const hot = Array.from(liveIds)
      .map((id) => auctions.get(id)!)
      .filter(Boolean)
      .sort((x, y) => y.bidCount - x.bidCount)
      .slice(0, 10)
      .map(summary)
    ack?.({ auctions: hot, serverNow: Date.now() })
  })
})

// viewer-count fan-out (coalesced every 2s — a delta frame, not a full snapshot)
setInterval(() => {
  for (const [socketId, ids] of watchedBy) {
    if (ids.size === 0) continue
    const counts: Record<string, number> = {}
    for (const id of ids) {
      counts[id] = io.sockets.adapter.rooms.get(roomName(id))?.size || 0
    }
    io.sockets.sockets.get(socketId)?.emit('viewers', { counts, at: Date.now() })
  }
}, VIEWER_BROADCAST_MS)

httpServer.listen(PORT, () => {
  console.log(`[engine] live auction engine listening on :${PORT}`)
})
process.on('SIGTERM', () => { httpServer.close(() => process.exit(0)) })
process.on('SIGINT', () => { httpServer.close(() => process.exit(0)) })
