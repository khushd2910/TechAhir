import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword } from '@/lib/auth'
import { signSession, sessionCookieOptions, SESSION_COOKIE } from '@/lib/session'

export async function POST(req: Request) {
  try {
    const { name, email, password } = (await req.json()) as {
      name?: string
      email?: string
      password?: string
    }
    const cleanEmail = email?.toLowerCase().trim()
    if (!cleanEmail || !/.+@.+\..+/.test(cleanEmail))
      return NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400 })
    if (!password || password.length < 6)
      return NextResponse.json({ error: 'Password must be at least 6 characters.' }, { status: 400 })

    const existing = await db.user.findUnique({ where: { email: cleanEmail } })
    if (existing)
      return NextResponse.json({ error: 'An account with this email already exists.' }, { status: 409 })

    const user = await db.user.create({
      data: {
        email: cleanEmail,
        name: name?.trim() || cleanEmail.split('@')[0],
        passwordHash: hashPassword(password),
      },
    })
    const sessionUser = { id: user.id, email: user.email, name: user.name ?? user.email.split('@')[0] }
    const res = NextResponse.json({ ok: true, user: sessionUser })
    res.cookies.set(SESSION_COOKIE, signSession(sessionUser), sessionCookieOptions())
    return res
  } catch {
    return NextResponse.json({ error: 'Registration failed. Please try again.' }, { status: 500 })
  }
}
