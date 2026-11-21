'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Eye, Flame, Gavel, Hammer, Search, TrendingUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { useTick } from '@/hooks/use-tick'
import {
  fmtCountdown, fmtNum, getSocket, money, rpc, syncClock,
  type AuctionSummary,
} from '@/lib/auction-client'

const CATEGORIES = ['All', 'Watches', 'Art', 'Music', 'Sports', 'Jewelry', 'Collectibles', 'Fashion', 'Vehicles']
const PAGE_SIZE = 24

interface Props {
  onOpenRoom: (id: string) => void
}

export function AuctionGrid({ onOpenRoom }: Props) {
  const [items, setItems] = useState<AuctionSummary[]>([])
  const [viewers, setViewers] = useState<Record<string, number>>({})
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<'ending' | 'bids'>('ending')
  const [category, setCategory] = useState('All')
  const [loading, setLoading] = useState(true)
  const [flashes, setFlashes] = useState<Record<string, 'up' | 'end'>>({})
  const { now, mounted } = useTick(500)
  const idsRef = useRef<string[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await rpc<{ auctions: AuctionSummary[]; total: number; serverNow: number }>('auction:list', {
        page, limit: PAGE_SIZE, q, sort, category: category === 'All' ? '' : category, status: 'live',
      })
      syncClock(res.serverNow)
      setItems(res.auctions)
      setTotal(res.total)
      const ids = res.auctions.map((a) => a.id)
      idsRef.current = ids
      getSocket().emit('watch', ids)
    } catch {
      /* transient */
    } finally {
      setLoading(false)
    }
  }, [page, q, sort, category])

  useEffect(() => { load() }, [load])

  // live deltas from the rooms we joined
  useEffect(() => {
    const s = getSocket()
    const onBid = (d: { auctionId: string; currentPrice: number; leaderName: string | null; bidCount: number; extensionCount?: number; version: number; endsAt: number; status?: string }) => {
      setItems((prev) => prev.map((a) =>
        a.id === d.auctionId
          ? { ...a, currentPrice: d.currentPrice, leaderName: d.leaderName, bidCount: d.bidCount, version: d.version, endsAt: d.endsAt }
          : a,
      ))
      setFlashes((f) => ({ ...f, [d.auctionId]: 'up' }))
      setTimeout(() => setFlashes((f) => (f[d.auctionId] === 'up' ? { ...f, [d.auctionId]: undefined } : f)), 900)
    }
    const onEnded = (d: { auctionId: string; winnerName: string | null; finalPrice: number }) => {
      setItems((prev) => prev.map((a) =>
        a.id === d.auctionId
          ? { ...a, status: 'ended', winnerName: d.winnerName, finalPrice: d.finalPrice }
          : a,
      ))
      // the lot is no longer "live" — refresh the listing shortly after
      setTimeout(() => { void load() }, 1500)
    }
    const onViewers = (d: { counts: Record<string, number> }) => setViewers((v) => ({ ...v, ...d.counts }))
    s.on('auction:bid', onBid)
    s.on('auction:ended', onEnded)
    s.on('viewers', onViewers)
    return () => {
      s.off('auction:bid', onBid)
      s.off('auction:ended', onEnded)
      s.off('viewers', onViewers)
    }
  }, [])

  // swap room membership when the visible page changes
  useEffect(() => {
    const prev = idsRef.current
    return () => {
      if (prev.length) getSocket().emit('unwatch', prev)
    }
  }, [items])

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-4">
      {/* controls */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/70" aria-hidden />
          <Input
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1) }}
            placeholder="Search 5,000+ lots…"
            className="border-border bg-muted/50 pl-9 text-foreground placeholder:text-muted-foreground/70"
            aria-label="Search auctions"
          />
        </div>
        <Select value={category} onValueChange={(v) => { setCategory(v); setPage(1) }}>
          <SelectTrigger className="w-full border-border bg-muted/50 text-foreground sm:w-44" aria-label="Category filter">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent className="border-border bg-stone-900 text-foreground">
            {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => setSort(v as 'ending' | 'bids')}>
          <SelectTrigger className="w-full border-border bg-muted/50 text-foreground sm:w-52" aria-label="Sort order">
            <SelectValue placeholder="Sort" />
          </SelectTrigger>
          <SelectContent className="border-border bg-stone-900 text-foreground">
            <SelectItem value="ending">Ending soonest</SelectItem>
            <SelectItem value="bids">Most bids</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading && items.length === 0 ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Gavel className="mr-3 h-5 w-5 animate-pulse" aria-hidden /> Loading live lots…
        </div>
      ) : items.length === 0 ? (
        <div className="py-20 text-center text-muted-foreground">No live lots match this filter.</div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {items.map((a) => {
            const rem = a.status === 'ended' ? 0 : a.endsAt - now
            const urgent = mounted && rem > 0 && rem < 30_000
            const vw = viewers[a.id] ?? 0
            return (
              <button
                key={a.id}
                onClick={() => onOpenRoom(a.id)}
                className="group rounded-xl border border-border bg-card/70 p-4 text-left transition hover:border-amber-400/40 hover:bg-accent"
                aria-label={`Open auction room for ${a.title}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground group-hover:text-amber-600 dark:text-amber-300">{a.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{a.category}</p>
                  </div>
                  {a.hot ? (
                    <Badge className="shrink-0 border-0 bg-red-500/15 text-red-400 hover:bg-red-500/25">
                      <Flame className="mr-1 h-3 w-3" aria-hidden /> HOT
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="shrink-0 border-border text-muted-foreground">{a.id}</Badge>
                  )}
                </div>

                <div className="mt-3 flex items-end justify-between">
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      {a.status === 'ended' ? 'Final price' : 'Current bid'}
                    </p>
                    <p
                      className={`font-mono text-xl font-semibold tabular-nums transition-colors duration-300 ${
                        flashes[a.id] === 'up' ? 'text-amber-600 dark:text-amber-300' : 'text-foreground'
                      }`}
                    >
                      {money(a.status === 'ended' && a.finalPrice != null ? a.finalPrice : a.currentPrice)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className={`font-mono text-sm tabular-nums ${urgent ? 'animate-pulse text-red-400' : rem === 0 ? 'text-muted-foreground' : 'text-foreground/80'}`}>
                      {a.status === 'ended' || !mounted ? '—' : fmtCountdown(rem)}
                    </p>
                    <p className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
                      <Eye className="h-3 w-3" aria-hidden /> {fmtNum(vw)} watching
                    </p>
                  </div>
                </div>

                <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <TrendingUp className="h-3 w-3 text-amber-600/70 dark:text-amber-400/70" aria-hidden />
                    {fmtNum(a.bidCount)} bids{a.extensionCount > 0 && <span className="ml-1 text-amber-600/80 dark:text-amber-400/80">· +{a.extensionCount} ext</span>}
                  </span>
                  {a.status === 'ended' ? (
                    <span className="flex items-center gap-1 text-emerald-400"><Hammer className="h-3 w-3" aria-hidden /> {a.winnerName ?? '—'}</span>
                  ) : (
                    <span className="max-w-[45%] truncate">{a.leaderName ? `leader: ${a.leaderName}` : 'no bids yet'}</span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* pagination */}
      <div className="flex items-center justify-center gap-3 pt-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="border-border text-foreground">
          <ChevronLeft className="h-4 w-4" aria-hidden /> Prev
        </Button>
        <span className="text-sm text-muted-foreground">Page {page} / {fmtNum(pages)} · {fmtNum(total)} live lots</span>
        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className="border-border text-foreground">
          Next <ChevronRight className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    </div>
  )
}
