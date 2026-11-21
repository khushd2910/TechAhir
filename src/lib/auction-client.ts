'use client'

import { io, Socket } from 'socket.io-client'

// ---------------------------------------------------------------- types
export interface AuctionSummary {
  id: string
  title: string
  category: string
  hot: boolean
  currentPrice: number
  startPrice: number
  minIncrement: number
  leaderId: string | null
  leaderName: string | null
  bidCount: number
  extensionCount: number
  version: number
  status: 'live' | 'ended'
  endsAt: number
  settledAt: number | null
  winnerId: string | null
  winnerName: string | null
  finalPrice: number | null
  recentBids?: BidRecord[]
}

export interface BidRecord {
  seq: number
  auctionId: string
  userId: string
  userName: string
  amount: number
  at: number
  version: number
  extended: boolean
}

export interface BidResult {
  accepted: boolean
  code: 'ACCEPTED' | 'NOT_FOUND' | 'ENDED' | 'LOW_BID' | 'STALE_VERSION' | 'DUPLICATE' | 'INVALID'
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

export interface ThroughputPoint {
  ts: number
  accepted: number
  rejected: number
}

export interface EngineStats {
  startedAt: number
  bidsAccepted: number
  bidsRejected: number
  rejections: Record<string, number>
  extensions: number
  settled: number
  peakBidsPerSec: number
  wsClients: number
  liveAuctions: number
  totalAuctions: number
  globalSeq: number
  serverNow: number
  uptimeMs: number
  load: {
    running: boolean
    config: { targetBps: number; hotShare: number; durationSec: number }
    startedAt: number | null
    commands: number
    accepted: number
    rejected: number
    extensions: number
    settled: number
    avgLatencyMs: number
    maxLatencyMs: number
  }
  throughput: ThroughputPoint[]
}

export interface ListResponse {
  auctions: AuctionSummary[]
  total: number
  page: number
  limit: number
  serverNow: number
}

// ---------------------------------------------------------------- socket singleton
let socket: Socket | null = null

export function getSocket(): Socket {
  if (!socket) {
    socket = io('/?XTransformPort=3002', {
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
      timeout: 10000,
    })
  }
  return socket
}

// Promise-based RPC over the single multiplexed connection (acks)
export function rpc<T>(event: string, payload?: unknown): Promise<T> {
  const s = getSocket()
  return new Promise<T>((resolve, reject) => {
    s.timeout(8000).emit(event, payload, (err: unknown, res: T) => {
      if (err) reject(err instanceof Error ? err : new Error('rpc timeout'))
      else resolve(res)
    })
  })
}

// ---------------------------------------------------------------- server clock sync
let clockOffset = 0

export function syncClock(serverNow: number): void {
  clockOffset = serverNow - Date.now()
}

export function serverNow(): number {
  return Date.now() + clockOffset
}

// ---------------------------------------------------------------- helpers
export const money = (n: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)

export const fmtNum = (n: number): string =>
  new Intl.NumberFormat('en-US').format(n)

export function remainingMs(endsAt: number): number {
  return Math.max(0, endsAt - serverNow())
}

export function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'ENDED'
  const totalSec = Math.floor(ms / 1000)
  const d = Math.floor(totalSec / 86400)
  const h = Math.floor((totalSec % 86400) / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m ${String(s).padStart(2, '0')}s`
  return `${m}:${String(s).padStart(2, '0')}`
}

export const REJECT_LABELS: Record<string, string> = {
  LOW_BID: 'Bid too low — must beat the current price by the minimum increment',
  ENDED: 'Auction already ended — a winner has been declared',
  DUPLICATE: 'Duplicate request (idempotency guard) — this exact bid was already processed',
  STALE_VERSION: 'Stale state — someone outbid you while you were typing',
  NOT_FOUND: 'Auction not found',
  INVALID: 'Invalid bid command',
}
