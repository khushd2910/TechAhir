import { NextResponse } from 'next/server'
import { verifySession, SESSION_COOKIE } from '@/lib/session'

export async function GET(req: Request) {
  const token = req.headers.get('cookie')?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.split('=')[1]
  const user = verifySession(token ? decodeURIComponent(token) : undefined)
  return NextResponse.json({ user })
}
