'use client'

import { useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import { ChevronDown, Gavel, LogOut, Moon, Sun, Volume2, VolumeX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { sounds } from '@/lib/sounds'
import type { AuthUser, TabKey } from '@/components/auction/types'

export const VIEW_TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'browse', label: 'Live Auctions' },
  { key: 'load', label: 'Load Test' },
  { key: 'design', label: 'Design Doc' },
]

interface Props {
  view: TabKey
  onNavigate: (v: TabKey) => void
  onOpenAuth: () => void
  user: AuthUser | null
  onSignOut: () => void
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 0)
    return () => clearTimeout(t)
  }, [])
  if (!mounted) return <span className="h-9 w-9" aria-hidden />
  const dark = resolvedTheme === 'dark'
  return (
    <Button
      variant="ghost" size="icon"
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {dark ? <Sun className="h-5 w-5" aria-hidden /> : <Moon className="h-5 w-5" aria-hidden />}
    </Button>
  )
}

function SoundToggle() {
  const [on, setOn] = useState(true)
  useEffect(() => {
    sounds.init()
    const t = setTimeout(() => setOn(sounds.enabled), 0)
    return () => clearTimeout(t)
  }, [])
  return (
    <Button
      variant="ghost" size="icon"
      onClick={() => setOn(sounds.toggle())}
      aria-label={on ? 'Mute sound effects' : 'Enable sound effects'}
      title={on ? 'Sound effects on' : 'Sound effects muted'}
    >
      {on ? <Volume2 className="h-5 w-5" aria-hidden /> : <VolumeX className="h-5 w-5 text-muted-foreground" aria-hidden />}
    </Button>
  )
}

export function Navbar({ view, onNavigate, onOpenAuth, user, onSignOut }: Props) {
  const signedIn = !!user

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-6">
          <button
            onClick={() => onNavigate('browse')}
            className="flex items-center gap-2.5"
            aria-label="HammerTime Live home"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500 text-black shadow-sm">
              <Gavel className="h-5 w-5" aria-hidden />
            </span>
            <span className="text-lg font-bold tracking-tight">
              HammerTime <span className="text-amber-500">Live</span>
            </span>
          </button>
          <nav className="hidden items-center gap-1 sm:flex" aria-label="Primary">
            {VIEW_TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => onNavigate(t.key)}
                className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  view === t.key
                    ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
                aria-current={view === t.key ? 'page' : undefined}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-1.5">
          <SoundToggle />
          <ThemeToggle />
          {signedIn ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="ml-1 gap-2 border-border">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-500 text-xs font-bold text-black" aria-hidden>
                    {(user.name ?? '?').slice(0, 1).toUpperCase()}
                  </span>
                  <span className="max-w-28 truncate text-sm">{user.name}</span>
                  <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <p className="text-sm font-medium">{user.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onSignOut} className="text-red-500 focus:text-red-500">
                  <LogOut className="mr-2 h-4 w-4" aria-hidden /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button
              onClick={onOpenAuth}
              className="ml-1 bg-amber-500 px-4 font-semibold text-black hover:bg-amber-400"
            >
              Sign in
            </Button>
          )}
        </div>
      </div>
      {/* mobile nav */}
      <nav className="flex gap-1 overflow-x-auto border-t border-border px-4 py-1.5 sm:hidden" aria-label="Primary mobile">
        {VIEW_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => onNavigate(t.key)}
            className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium ${
              view === t.key
                ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                : 'text-muted-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </header>
  )
}
