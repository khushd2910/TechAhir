'use client'

import { useEffect, useState } from 'react'
import { Activity, Gavel, Timer, TrendingUp, Users, Zap } from 'lucide-react'
import { getSocket, rpc, syncClock, fmtNum, type EngineStats } from '@/lib/auction-client'

export function StatsBar() {
  const [stats, setStats] = useState<EngineStats | null>(null)

  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const s = await rpc<EngineStats>('auction:stats', {})
        if (!alive) return
        syncClock(s.serverNow)
        setStats(s)
      } catch {
        /* transient */
      }
    }
    poll()
    const t = setInterval(poll, 1000)
    const sock = getSocket()
    sock.on('connect', poll)
    return () => {
      alive = false
      clearInterval(t)
      sock.off('connect', poll)
    }
  }, [])

  const last = stats?.throughput[stats.throughput.length - 1]
  const bps = last ? last.accepted + last.rejected : 0

  const items = [
    { icon: Gavel, label: 'Live auctions', value: stats ? fmtNum(stats.liveAuctions) : '—', sub: `${fmtNum(stats?.totalAuctions ?? 0)} total` },
    { icon: Zap, label: 'Bids / sec (now)', value: stats ? fmtNum(bps) : '—', sub: `peak ${fmtNum(stats?.peakBidsPerSec ?? 0)}/s` },
    { icon: Activity, label: 'Bids accepted', value: stats ? fmtNum(stats.bidsAccepted) : '—', sub: `${fmtNum(stats?.bidsRejected ?? 0)} rejected` },
    { icon: Timer, label: 'Anti-snipe extensions', value: stats ? fmtNum(stats.extensions) : '—', sub: `${fmtNum(stats?.settled ?? 0)} settled` },
    { icon: Users, label: 'Watchers connected', value: stats ? fmtNum(stats.wsClients) : '—', sub: 'socket.io rooms' },
    { icon: TrendingUp, label: 'Write latency (avg)', value: stats?.load.avgLatencyMs != null ? `${stats.load.avgLatencyMs.toFixed(2)} ms` : '—', sub: `max ${stats?.load.maxLatencyMs.toFixed(2) ?? '—'} ms` },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      {items.map((it) => (
        <div key={it.label} className="rounded-xl border border-border bg-card/70 p-4 backdrop-blur">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <it.icon className="h-3.5 w-3.5 text-amber-400" aria-hidden />
            {it.label}
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-foreground">{it.value}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">{it.sub}</div>
        </div>
      ))}
    </div>
  )
}
