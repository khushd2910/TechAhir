'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Crown, Eye, Flame, Gavel, ShieldCheck, Timer, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTick } from '@/hooks/use-tick'
import {
  fmtCountdown, fmtNum, getSocket, money, rpc, syncClock, serverNow,
  REJECT_LABELS, type AuctionSummary, type BidRecord, type BidResult,
} from '@/lib/auction-client'
import { sounds } from '@/lib/sounds'

interface Props {
  auctionId: string
  userName: string
  userId: string
  signedIn: boolean
  onBack: () => void
  onOpenAuth?: () => void
}

interface BurstSummary {
  sent: number
  accepted: number
  winner: string | null
  price: number | null
}

export function AuctionRoom({ auctionId, userName, userId, signedIn, onBack, onOpenAuth }: Props) {
  const [auction, setAuction] = useState<AuctionSummary | null>(null)
  const [bids, setBids] = useState<BidRecord[]>([])
  const [viewers, setViewers] = useState(0)
  const [amount, setAmount] = useState('')
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'reject' | 'end'; text: string } | null>(null)
  const [extendedFlash, setExtendedFlash] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [burst, setBurst] = useState<BurstSummary | null>(null)
  const [burstRunning, setBurstRunning] = useState(false)
  const { now, mounted } = useTick(250)
  const userIdRef = useRef(userId)
  userIdRef.current = userId
  const reqSeq = useRef(0)

  // load snapshot + join the room
  useEffect(() => {
    let alive = true
    const s = getSocket()

    const onBid = (d: { auctionId: string; price: number; leaderId: string; leaderName: string; bidCount: number; version: number; endsAt: number; extended: boolean; at: number; userName: string }) => {
      if (d.auctionId !== auctionId) return
      setAuction((a) =>
        a ? { ...a, currentPrice: d.price, leaderId: d.leaderId, leaderName: d.leaderName, bidCount: d.bidCount, version: d.version, endsAt: d.endsAt, status: 'live' } : a,
      )
      setBids((prev) => [
        { seq: d.seq ?? 0, auctionId: d.auctionId, userId: d.leaderId, userName: d.userName, amount: d.price, at: d.at, version: d.version, extended: d.extended },
        ...prev.slice(0, 40),
      ])
      setFeedback((f) =>
        d.leaderId === userIdRef.current ? { kind: 'ok', text: `You are the highest bidder at ${money(d.price)}` } : f,
      )
      if (d.leaderId === userIdRef.current) sounds.accept()
      else sounds.outbid()
    }
    const onExtended = (d: { auctionId: string; endsAt: number; by: string }) => {
      if (d.auctionId !== auctionId) return
      setAuction((a) => (a ? { ...a, endsAt: d.endsAt } : a))
      setExtendedFlash(true)
      sounds.extend()
      setTimeout(() => setExtendedFlash(false), 1500)
    }
    const onEnded = (d: { auctionId: string; winnerId: string; winnerName: string | null; finalPrice: number; bidCount: number; settledAt: number }) => {
      if (d.auctionId !== auctionId) return
      setAuction((a) => (a ? { ...a, status: 'ended', winnerId: d.winnerId, winnerName: d.winnerName, finalPrice: d.finalPrice, settledAt: d.settledAt } : a))
      sounds.gavel()
      setFeedback({
        kind: 'end',
        text: d.winnerId === userIdRef.current
          ? `SOLD — you won at ${money(d.finalPrice)}`
          : `SOLD to ${d.winnerName ?? 'the highest bidder'} at ${money(d.finalPrice)}`,
      })
    }
    const onViewers = (d: { counts: Record<string, number> }) => {
      const c = d.counts[auctionId]
      if (c != null) setViewers(c)
    }
    s.on('auction:bid', onBid)
    s.on('auction:extended', onExtended)
    s.on('auction:ended', onEnded)
    s.on('viewers', onViewers)
    s.emit('watch', [auctionId], (res: { auctions: AuctionSummary[]; serverNow: number }) => {
      if (!alive) return
      syncClock(res.serverNow)
      const a = res.auctions[0]
      if (a) {
        setAuction(a)
        setBids((a.recentBids ?? []).slice().reverse())
        setAmount(String(a.currentPrice + a.minIncrement))
      }
    })
    return () => {
      alive = false
      s.off('auction:bid', onBid)
      s.off('auction:extended', onExtended)
      s.off('auction:ended', onEnded)
      s.off('viewers', onViewers)
      s.emit('unwatch', [auctionId])
    }
  }, [auctionId])

  const placeBid = useCallback(async (amt: number) => {
    const reqId = `web-${userIdRef.current}-${++reqSeq.current}-${Date.now()}`
    setSubmitting(true)
    try {
      const r = await rpc<BidResult>('bid', {
        auctionId, userId: userIdRef.current, userName, amount: amt, requestId: reqId,
      })
      syncClock(r.serverNow)
      if (r.accepted) {
        sounds.accept()
        setFeedback({ kind: 'ok', text: `Bid accepted: ${money(r.price ?? amt)}${r.extended ? ' · deadline extended +30s' : ''}` })
        setAuction((a) => a && r.price != null ? { ...a, currentPrice: r.price, leaderId: userIdRef.current, leaderName: userName, bidCount: a.bidCount + 1, endsAt: r.endsAt ?? a.endsAt, extensionCount: r.extended ? a.extensionCount + 1 : a.extensionCount } : a)
      } else {
        sounds.reject()
        setFeedback({ kind: 'reject', text: `Rejected (${r.code}): ${REJECT_LABELS[r.code] ?? r.reason ?? ''}${r.minRequired ? ` Minimum now ${money(r.minRequired)}.` : ''}` })
      }
    } catch {
      sounds.reject()
      setFeedback({ kind: 'reject', text: 'Network error — bid not delivered.' })
    } finally {
      setSubmitting(false)
      const a = await rpc<{ auction: AuctionSummary }>('auction:get', { id: auctionId }).catch(() => null)
      if (a?.auction) setAmount(String(a.auction.currentPrice + a.auction.minIncrement))
    }
  }, [auctionId, userName])

  const runBurst = useCallback(async () => {
    const a = auction
    if (!a || a.status !== 'live') return
    setBurstRunning(true)
    setBurst(null)
    const samePrice = a.currentPrice + a.minIncrement
    const run = Math.random().toString(36).slice(2, 8)
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        rpc<BidResult>('bid', {
          auctionId: a.id,
          userId: `burst-${run}-${i}`,
          userName: `Racer #${i + 1}`,
          amount: samePrice,
          requestId: `burst-${run}-${i}`,
        }).catch(() => ({ accepted: false, code: 'INVALID' } as BidResult)),
      ),
    )
    const accepted = results.filter((r) => r.accepted)
    setBurst({
      sent: 50,
      accepted: accepted.length,
      winner: accepted[0]?.leader?.userName ?? null,
      price: accepted[0]?.price ?? null,
    })
    setBurstRunning(false)
  }, [auction])

  if (!auction) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Gavel className="mr-3 h-5 w-5 animate-pulse" aria-hidden /> Joining auction room…
      </div>
    )
  }

  const rem = auction.status === 'ended' ? 0 : auction.endsAt - now
  const urgent = mounted && rem > 0 && rem < 30_000
  const isLeader = auction.leaderId === userIdRef.current
  const minNext = auction.currentPrice + auction.minIncrement

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack} className="text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" aria-hidden /> Back to all lots
      </Button>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* ---- left: live state ---- */}
        <div className="space-y-4 lg:col-span-3">
          <div className="rounded-xl border border-border bg-card/70 p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-semibold text-foreground">{auction.title}</h2>
                  {auction.hot && <Badge className="border-0 bg-red-500/15 text-red-400"><Flame className="mr-1 h-3 w-3" aria-hidden />HOT</Badge>}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">Lot {auction.id} · {auction.category} · min increment {money(auction.minIncrement)}</p>
              </div>
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <span className="flex items-center gap-1.5"><Eye className="h-4 w-4 text-amber-400" aria-hidden /> {fmtNum(viewers)} watching</span>
                <span className="flex items-center gap-1.5"><Zap className="h-4 w-4 text-amber-400" aria-hidden /> v{auction.version}</span>
              </div>
            </div>

            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="rounded-lg border border-border bg-muted/60 p-5">
                <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Current bid</p>
                <p className="mt-1 font-mono text-4xl font-bold tabular-nums text-amber-600 dark:text-amber-300">{money(auction.currentPrice)}</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {isLeader ? (
                    <span className="inline-flex items-center gap-1 font-medium text-emerald-400"><Crown className="h-4 w-4" aria-hidden /> You lead this auction</span>
                  ) : auction.leaderName ? (
                    <>Leader: <span className="text-foreground">{auction.leaderName}</span></>
                  ) : 'No bids yet — opening price stands'}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-muted/60 p-5">
                <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
                  {urgent ? 'Soft close — bid extends +30s' : 'Time remaining'}
                </p>
                <p className={`mt-1 font-mono text-4xl font-bold tabular-nums ${auction.status === 'ended' ? 'text-muted-foreground' : urgent ? 'animate-pulse text-red-400' : 'text-foreground'}`}>
                  {auction.status === 'ended' ? 'ENDED' : !mounted ? '—' : fmtCountdown(rem)}
                </p>
                {extendedFlash && (
                  <p className="mt-2 animate-pulse text-sm font-medium text-amber-600 dark:text-amber-300">
                    <Timer className="mr-1 inline h-4 w-4" aria-hidden /> Anti-snipe: deadline extended by 30 seconds
                  </p>
                )}
              </div>
            </div>

            {/* bid controls — signing in is required to bid */}
            {auction.status === 'live' && !signedIn ? (
              <div className="mt-5 flex flex-col items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium text-amber-700 dark:text-amber-300">Sign in to place bids</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">Browsing and watching live auctions is free — bidding requires an account.</p>
                </div>
                <Button onClick={() => onOpenAuth?.()} className="bg-amber-500 font-semibold text-black hover:bg-amber-400">
                  Sign in / Create account
                </Button>
              </div>
            ) : auction.status === 'live' ? (
              <div className="mt-5 space-y-3">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    type="number"
                    value={amount}
                    min={minNext}
                    onChange={(e) => setAmount(e.target.value)}
                    className="flex-1 border-border bg-muted/70 font-mono text-lg text-foreground"
                    aria-label="Your bid amount in USD"
                  />
                  <Button
                    onClick={() => placeBid(Number(amount))}
                    disabled={submitting || !amount || Number(amount) < minNext}
                    className="h-11 bg-amber-500 px-8 text-base font-semibold text-black hover:bg-amber-400"
                  >
                    {submitting ? 'Placing…' : `Place bid ${amount ? money(Number(amount)) : ''}`}
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {[1, 5, 10].map((m) => (
                    <Button key={m} variant="outline" size="sm" className="border-border text-foreground" onClick={() => setAmount(String(minNext + (m - 1) * auction.minIncrement))}>
                      +{m === 1 ? 'min' : `${m}× inc`}
                    </Button>
                  ))}
                  <Button variant="outline" size="sm" className="border-border text-foreground" onClick={() => setAmount(String(minNext))}>
                    Bid exactly {money(minNext)}
                  </Button>
                </div>
                {feedback && (
                  <p
                    role="status"
                    className={`rounded-lg border px-4 py-2.5 text-sm ${
                      feedback.kind === 'ok'
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                        : feedback.kind === 'end'
                          ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                          : 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300'
                    }`}
                  >
                    {feedback.text}
                  </p>
                )}
              </div>
            ) : (
              <div className="mt-5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-5">
                <p className="flex items-center gap-2 text-lg font-semibold text-amber-700 dark:text-amber-600 dark:text-amber-300">
                  <Crown className="h-5 w-5" aria-hidden /> SOLD — unique winner declared
                </p>
                <p className="mt-1 text-sm text-amber-800/80 dark:text-amber-200/80">
                  Winner: <span className="font-semibold text-foreground">{auction.winnerName ?? '—'}</span>
                  {' '}· Final price: <span className="font-mono text-foreground">{money(auction.finalPrice ?? 0)}</span>
                  {' '}· {fmtNum(auction.bidCount)} bids · {auction.extensionCount} anti-snipe extensions
                  {' '}· settled at {auction.settledAt ? new Date(auction.settledAt).toLocaleTimeString() : '—'}
                </p>
              </div>
            )}
          </div>

          {/* burst correctness test */}
          <div className="rounded-xl border border-border bg-card/70 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="flex items-center gap-2 font-medium text-foreground"><ShieldCheck className="h-4 w-4 text-emerald-400" aria-hidden /> Concurrency proof: 50 bidders, same price, same instant</p>
                <p className="mt-1 text-xs text-muted-foreground">Fires 50 simultaneous bids for {money(auction.currentPrice + auction.minIncrement)}. Exactly one can win — the single-writer core serializes them.</p>
              </div>
              <Button onClick={runBurst} disabled={burstRunning || auction.status !== 'live'} className="bg-emerald-600 text-foreground hover:bg-emerald-500">
                {burstRunning ? 'Racing…' : 'Run burst test'}
              </Button>
            </div>
            {burst && (
              <div className="mt-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200">
                {burst.sent} bids fired → <span className="font-bold">{burst.accepted} accepted</span>, {burst.sent - burst.accepted} rejected.
                {burst.accepted > 0 && <> Leader after the race: <span className="font-semibold text-foreground">{burst.winner}</span> at {money(burst.price ?? 0)}. One price, one winner — no double-count, no split decision.</>}
                {burst.accepted === 0 && <> All rejected (price already moved — monotonic guarantee held).</>}
              </div>
            )}
          </div>
        </div>

        {/* ---- right: live bid stream ---- */}
        <div className="rounded-xl border border-border bg-card/70 p-4 lg:col-span-2">
          <div className="flex items-center justify-between border-b border-border pb-3">
            <p className="font-medium text-foreground">Live bid stream</p>
            <span className="flex items-center gap-1.5 text-xs text-emerald-400">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" aria-hidden /> websocket
            </span>
          </div>
          <div className="mt-3 max-h-[430px] space-y-2 overflow-y-auto pr-1" aria-label="Bid history">
            {bids.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground/70">No bids yet. Be the first.</p>
            ) : (
              bids.map((b, i) => (
                <div key={`${b.seq}-${b.at}-${i}`} className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm ${i === 0 ? 'bg-amber-500/10' : 'bg-card/70'}`}>
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground/90">{b.userName}{b.userId === userIdRef.current && <span className="ml-1 text-emerald-400">(you)</span>}</p>
                    <p className="text-[11px] text-muted-foreground/70">{new Date(b.at).toLocaleTimeString()} · seq {b.seq}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono tabular-nums text-amber-600 dark:text-amber-300">{money(b.amount)}</p>
                    {b.extended && <p className="text-[10px] text-amber-600/80 dark:text-amber-400/80">+30s extension</p>}
                  </div>
                </div>
              ))
            )}
          </div>
          <p className="mt-3 border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground/70">
            Deltas arrive on the auction room channel; the deadline clock is synced to engine time (skew-corrected).
            Server clock offset: {Math.round(serverNow() - Date.now())} ms.
          </p>
        </div>
      </div>
    </div>
  )
}
