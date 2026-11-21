'use client'

import { useEffect, useState } from 'react'
import { Gavel, Wifi, WifiOff } from 'lucide-react'
import { StatsBar } from '@/components/auction/stats-bar'
import { AuctionGrid } from '@/components/auction/auction-grid'
import { AuctionRoom } from '@/components/auction/auction-room'
import { LoadTestPanel } from '@/components/auction/load-test'
import { DesignDoc } from '@/components/auction/design-doc'
import { Navbar } from '@/components/auction/navbar'
import { AuthDialog } from '@/components/auction/auth-dialog'
import type { AuthUser, TabKey } from '@/components/auction/types'
import { getSocket, rpc, syncClock } from '@/lib/auction-client'
import { sounds } from '@/lib/sounds'

export default function Home() {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [view, setView] = useState<TabKey>('browse')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [guestName, setGuestName] = useState('')
  const [authOpen, setAuthOpen] = useState(false)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    // random identity must be generated client-side only (hydration-safe)
    const t = setTimeout(() => setGuestName(`Guest-${Math.floor(1000 + Math.random() * 9000)}`), 0)
    fetch('/api/auth/session').then((r) => r.json()).then((d) => setUser(d.user ?? null)).catch(() => {})
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    let alive = true
    const init = async () => {
      const s = getSocket()
      try {
        const st = await rpc<{ serverNow: number }>('auction:stats', {})
        syncClock(st.serverNow)
      } catch { /* transient */ }
      if (!alive) return
      setConnected(s.connected)
    }
    init()
    const onConnect = () => setConnected(true)
    const onDisconnect = () => setConnected(false)
    const s = getSocket()
    s.on('connect', onConnect)
    s.on('disconnect', onDisconnect)
    return () => {
      alive = false
      s.off('connect', onConnect)
      s.off('disconnect', onDisconnect)
    }
  }, [])

  const signedIn = !!user
  const userName = signedIn ? user!.name : guestName || 'Guest'
  const bidUserId = signedIn ? user!.id : `guest-${guestName}`

  const navigate = (v: TabKey) => {
    sounds.click()
    setView(v)
  }

  const openRoom = (id: string) => {
    sounds.click()
    setSelectedId(id)
    setView('room')
  }

  return (
    <div className="relative flex min-h-screen flex-col bg-background text-foreground">
      {/* subtle brand glow, visible in both themes */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-amber-500/[0.05]" aria-hidden />

      <Navbar view={view} onNavigate={navigate} onOpenAuth={() => setAuthOpen(true)} user={user} onSignOut={async () => { await fetch('/api/auth/logout', { method: 'POST' }); setUser(null); sounds.click() }} />

      <main className="relative z-10 mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
        {/* status strip */}
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              {view === 'browse' && 'Live Auctions'}
              {view === 'room' && 'Auction Room'}
              {view === 'load' && 'Load Test'}
              {view === 'design' && 'Design Brief'}
            </h1>
            <p className="text-sm text-muted-foreground">
              5,000 concurrent auctions · single-writer engine · anti-snipe soft close
            </p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 ${
                connected
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400'
              }`}
              role="status"
            >
              {connected ? <Wifi className="h-3.5 w-3.5" aria-hidden /> : <WifiOff className="h-3.5 w-3.5" aria-hidden />}
              {connected ? 'Engine live' : 'Reconnecting…'}
            </span>
            <span className="hidden rounded-full border border-border bg-muted px-3 py-1.5 text-muted-foreground sm:inline">
              Bidding as <span className="font-medium text-foreground">{userName || 'Guest'}</span>
            </span>
          </div>
        </div>

        <StatsBar />

        {/* Auction Room is reached from the grid; other views straight from the navbar */}
        <div className="mt-6">
          {view === 'browse' && <AuctionGrid onOpenRoom={openRoom} />}
          {view === 'room' && selectedId && (
            <AuctionRoom auctionId={selectedId} userName={userName} userId={bidUserId} signedIn={signedIn} onBack={() => navigate('browse')} onOpenAuth={() => setAuthOpen(true)} />
          )}
          {view === 'room' && !selectedId && (
            <p className="py-16 text-center text-muted-foreground">Pick a lot from Live Auctions first.</p>
          )}
          {view === 'load' && <LoadTestPanel />}
          {view === 'design' && <DesignDoc />}
        </div>
      </main>

      <footer className="relative z-10 mt-auto border-t border-border bg-muted/30 py-5 text-center text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Gavel className="h-3.5 w-3.5 text-amber-500" aria-hidden />
          HammerTime Live — one atomic critical section per auction · final 30s soft-close (+30s) · exactly one winner · sign in to bid
        </span>
      </footer>

      <AuthDialog open={authOpen} onOpenChange={setAuthOpen} onAuth={(u) => { setUser(u); sounds.accept() }} />
    </div>
  )
}
