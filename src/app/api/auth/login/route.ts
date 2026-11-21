import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyPassword } from '@/lib/auth'
import { signSession, sessionCookieOptions, SESSION_COOKIE } from '@/lib/session'

export async function POST(req: Request) {
  try {
    const { email, password } = (await req.json()) as { email?: string; password?: string }
    const cleanEmail = email?.toLowerCase().trim()
    if (!cleanEmail || !password)
      return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 })

    const user = await db.user.findUnique({ where: { email: cleanEmail } })
    if (!user || !verifyPassword(password, user.passwordHash))
      return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 })

    const sessionUser = { id: user.id, email: user.email, name: user.name ?? user.email.split('@')[0] }
    const res = NextResponse.json({ ok: true, user: sessionUser })
    res.cookies.set(SESSION_COOKIE, signSession(sessionUser), sessionCookieOptions())
    return res
  } catch {
    return NextResponse.json({ error: 'Sign-in failed. Please try again.' }, { status: 500 })
  }
}
