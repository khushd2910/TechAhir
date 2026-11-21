'use client'

import { useEffect, useState } from 'react'
import { serverNow } from '@/lib/auction-client'

/**
 * Ticking clock driven by the server-synced timestamp (immune to client clock
 * skew). Hydration-safe: `mounted` is false until the client takes over, and
 * time-dependent text is only rendered after that.
 */
export function useTick(intervalMs = 500): { now: number; mounted: boolean } {
  const [now, setNow] = useState(0)
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    const kick = setTimeout(() => { setMounted(true); setNow(serverNow()) }, 0)
    const t = setInterval(() => setNow(serverNow()), intervalMs)
    return () => {
      clearTimeout(kick)
      clearInterval(t)
    }
  }, [intervalMs])
  return { now, mounted }
}
