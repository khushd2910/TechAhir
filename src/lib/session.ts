import { createHmac, timingSafeEqual } from 'crypto'

const SECRET = process.env.NEXTAUTH_SECRET || 'hammertime-dev-secret-do-not-use-in-prod'
export const SESSION_COOKIE = 'ht_session'
const MAX_AGE = 7 * 24 * 3600

export interface SessionUser {
  id: string
  email: string
  name: string
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

/** Sign a session payload: base64url(json).base64url(hmac-sha256) */
export function signSession(user: SessionUser): string {
  const payload = b64url(JSON.stringify({ ...user, exp: Date.now() + MAX_AGE * 1000 }))
  const sig = b64url(createHmac('sha256', SECRET).update(payload).digest())
  return `${payload}.${sig}`
}

export function verifySession(token: string | undefined): SessionUser | null {
  if (!token) return null
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const expected = createHmac('sha256', SECRET).update(payload).digest()
  const given = Buffer.from(sig, 'base64url')
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as SessionUser & { exp: number }
    if (!data.exp || data.exp < Date.now()) return null
    return { id: data.id, email: data.email, name: data.name }
  } catch {
    return null
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: false,
    path: '/',
    maxAge: MAX_AGE,
  }
}
