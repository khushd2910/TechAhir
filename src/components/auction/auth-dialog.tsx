'use client'

import { useState } from 'react'
import { Gavel, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { AuthUser } from '@/components/auction/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAuth: (user: AuthUser) => void
}

export function AuthDialog({ open, onOpenChange, onAuth }: Props) {
  const [tab, setTab] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const reset = () => { setError(''); setBusy(false) }

  const post = async (url: string, body: Record<string, string>) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, data } as { ok: boolean; data: { error?: string; user?: AuthUser } }
  }

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    const { ok, data } = await post('/api/auth/login', { email, password })
    setBusy(false)
    if (!ok || !data.user) {
      setError(data.error || 'Invalid email or password.')
      return
    }
    onAuth(data.user)
    onOpenChange(false)
  }

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    const { ok, data } = await post('/api/auth/register', { name, email, password })
    setBusy(false)
    if (!ok || !data.user) {
      setError(data.error || 'Registration failed.')
      return
    }
    onAuth(data.user)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gavel className="h-5 w-5 text-amber-500" aria-hidden /> Welcome to HammerTime
          </DialogTitle>
          <DialogDescription>
            Sign in to place bids. Watching live auctions is always free.
          </DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={(v) => { setTab(v as 'signin' | 'signup'); setError('') }}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="signin">Sign in</TabsTrigger>
            <TabsTrigger value="signup">Create account</TabsTrigger>
          </TabsList>

          <TabsContent value="signin">
            <form onSubmit={handleSignIn} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="si-email">Email</Label>
                <Input id="si-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="si-pass">Password</Label>
                <Input id="si-pass" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
              </div>
              {error && <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">{error}</p>}
              <Button type="submit" disabled={busy} className="w-full bg-amber-500 text-black hover:bg-amber-400">
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />} Sign in
              </Button>
            </form>
          </TabsContent>

          <TabsContent value="signup">
            <form onSubmit={handleSignUp} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="su-name">Display name</Label>
                <Input id="su-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Bidder Smith" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="su-email">Email</Label>
                <Input id="su-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="su-pass">Password</Label>
                <Input id="su-pass" type="password" autoComplete="new-password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" />
              </div>
              {error && <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">{error}</p>}
              <Button type="submit" disabled={busy} className="w-full bg-amber-500 text-black hover:bg-amber-400">
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />} Create account
              </Button>
            </form>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
