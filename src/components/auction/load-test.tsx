'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Play, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import {
  fmtNum, getSocket, money, rpc, syncClock,
  type AuctionSummary, type EngineStats,
} from '@/lib/auction-client'

export function LoadTestPanel() {
  const [targetBps, setTargetBps] = useState(3000)
  const [hotShare, setHotShare] = useState(40)
  const [duration, setDuration] = useState(30)
  const [stats, setStats] = useState<EngineStats | null>(null)
  const [hot, setHot] = useState<AuctionSummary[]>([])
  const running = stats?.load.running ?? false
  const aliveRef = useRef(true)

  const poll = useCallback(async () => {
    try {
      const s = await rpc<EngineStats>('auction:stats', {})
      syncClock(s.serverNow)
      if (aliveRef.current) setStats(s)
    } catch { /* transient */ }
    try {
      const h = await rpc<{ auctions: AuctionSummary[] }>('load:hot', {})
      if (aliveRef.current) setHot(h.auctions)
    } catch { /* transient */ }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    const kick = setTimeout(poll, 0)
    const t = setInterval(poll, 1000)
    return () => { aliveRef.current = false; clearTimeout(kick); clearInterval(t) }
  }, [poll])

  const start = async () => {
    await rpc('load:start', { targetBps, hotShare: hotShare / 100, durationSec: duration })
    poll()
  }
  const stop = async () => {
    await rpc('load:stop', {})
    poll()
  }

  const chart = (stats?.throughput ?? []).map((p) => ({
    t: new Date(p.ts).toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' }),
    accepted: p.accepted,
    rejected: p.rejected,
  }))
  const load = stats?.load

  return (
    <div className="space-y-4">
      {/* controls */}
      <div className="rounded-xl border border-border bg-card/70 p-5">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          <div>
            <Label className="text-muted-foreground">Target load: <span className="font-mono text-amber-600 dark:text-amber-300">{fmtNum(targetBps)}</span> bids/sec</Label>
            <Slider value={[targetBps]} min={200} max={20000} step={200} onValueChange={(v) => setTargetBps(v[0])} className="mt-3" aria-label="Target bids per second" />
          </div>
          <div>
            <Label className="text-muted-foreground">Hot-auction share: <span className="font-mono text-amber-600 dark:text-amber-300">{hotShare}%</span> (anti-snipe storm)</Label>
            <Slider value={[hotShare]} min={0} max={100} step={5} onValueChange={(v) => setHotShare(v[0])} className="mt-3" aria-label="Hot auction traffic share" />
          </div>
          <div>
            <Label className="text-muted-foreground">Duration: <span className="font-mono text-amber-600 dark:text-amber-300">{duration}s</span></Label>
            <Slider value={[duration]} min={10} max={120} step={5} onValueChange={(v) => setDuration(v[0])} className="mt-3" aria-label="Test duration in seconds" />
          </div>
        </div>
        <div className="mt-5 flex items-center gap-3">
          {running ? (
            <Button onClick={stop} variant="destructive"><Square className="mr-2 h-4 w-4" aria-hidden /> Stop test</Button>
          ) : (
            <Button onClick={start} className="bg-amber-500 text-black hover:bg-amber-400"><Play className="mr-2 h-4 w-4" aria-hidden /> Start load test</Button>
          )}
          <p className="text-sm text-muted-foreground">
            {running
              ? <>Running — hot auctions are pinned near their 30s soft-close window so you can watch extensions fire live.</>
              : 'Bot bidders hammer the engine through the same single-writer write path as real users.'}
          </p>
        </div>
      </div>

      {/* counters */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {[
          { l: 'Commands sent', v: load ? fmtNum(load.commands) : '—' },
          { l: 'Accepted', v: load ? fmtNum(load.accepted) : '—', ok: true },
          { l: 'Rejected', v: load ? fmtNum(load.rejected) : '—', warn: true },
          { l: 'Extensions triggered', v: load ? fmtNum(load.extensions) : '—' },
          { l: 'Write latency avg', v: load ? `${load.avgLatencyMs.toFixed(3)} ms` : '—', ok: true },
          { l: 'Write latency max', v: load ? `${load.maxLatencyMs.toFixed(3)} ms` : '—', warn: true },
        ].map((c) => (
          <div key={c.l} className="rounded-xl border border-border bg-card/70 p-4">
            <p className="text-xs text-muted-foreground">{c.l}</p>
            <p className={`mt-1.5 font-mono text-2xl font-semibold tabular-nums ${c.ok ? 'text-emerald-400' : c.warn ? 'text-red-400' : 'text-foreground'}`}>{c.v}</p>
          </div>
        ))}
      </div>

      {/* throughput chart */}
      <div className="rounded-xl border border-border bg-card/70 p-5">
        <p className="font-medium text-foreground">Command throughput (rolling 120s)</p>
        <div className="mt-4 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chart} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="t" tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} />
              <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--popover-foreground)' }}
                formatter={(v: number, name: string) => [fmtNum(v), name]}
              />
              <Area dataKey="accepted" stroke="#fbbf24" fill="#fbbf24" fillOpacity={0.25} name="accepted" />
              <Area dataKey="rejected" stroke="#f87171" fill="#f87171" fillOpacity={0.15} name="rejected" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          <CheckCircle2 className="mr-1 inline h-3 w-3 text-emerald-400" aria-hidden /> accepted — price moved, version bumped
          · <AlertTriangle className="mr-1 inline h-3 w-3 text-red-400" aria-hidden /> rejected — low bid / ended / duplicate (admission control at work)
        </p>
      </div>

      {/* hottest auctions */}
      <div className="rounded-xl border border-border bg-card/70 p-5">
        <p className="font-medium text-foreground">Hottest live lots right now</p>
        <div className="mt-3 max-h-72 overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="pb-2 pr-2">Lot</th>
                <th className="pb-2 pr-2">Price</th>
                <th className="pb-2 pr-2">Bids</th>
                <th className="pb-2 pr-2">Extensions</th>
                <th className="pb-2">Version</th>
              </tr>
            </thead>
            <tbody>
              {hot.length === 0 ? (
                <tr><td colSpan={5} className="py-6 text-center text-muted-foreground/70">Start the load test to heat things up.</td></tr>
              ) : (
                hot.map((a) => (
                  <tr key={a.id} className="border-t border-border text-foreground/80">
                    <td className="max-w-[280px] truncate py-2 pr-2 text-foreground">{a.title}</td>
                    <td className="py-2 pr-2 font-mono tabular-nums text-amber-600 dark:text-amber-300">{money(a.currentPrice)}</td>
                    <td className="py-2 pr-2 font-mono tabular-nums">{fmtNum(a.bidCount)}</td>
                    <td className="py-2 pr-2 font-mono tabular-nums text-amber-400">{a.extensionCount}</td>
                    <td className="py-2 font-mono tabular-nums">v{a.version}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-center text-xs text-muted-foreground/70">Socket.io engine: {getSocket() ? 'connected via gateway' : '—'} · every command above went through the same critical section as real user bids.</p>
    </div>
  )
}
