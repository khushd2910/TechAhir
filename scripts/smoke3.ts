import { io } from 'socket.io-client'
const run = Math.random().toString(36).slice(2, 8)
const socket = io('http://localhost:3002', { transports: ['websocket'] })
const rpc = <T>(e: string, p?: unknown): Promise<T> =>
  new Promise((res, rej) => socket.timeout(5000).emit(e, p, (err: unknown, r: T) => err ? rej(err) : res(r)))
socket.on('connect', async () => {
  // find a live auction with < 30s remaining
  let target: { id: string; currentPrice: number; minIncrement: number; endsAt: number } | null = null
  for (let i = 0; i < 20 && !target; i++) {
    const l = await rpc<{ auctions: Array<{ id: string; currentPrice: number; minIncrement: number; endsAt: number; status: string }> }>('auction:list', { page: 1, limit: 60 })
    const now = Date.now()
    target = l.auctions.find(x => x.status === 'live' && x.endsAt - now < 28000) || null
    if (!target) await new Promise(r => setTimeout(r, 1000))
  }
  if (!target) { console.log('no near-deadline auction found'); process.exit(1) }
  console.log('target:', target.id, 'remaining:', target.endsAt - Date.now(), 'ms')
  const ext = await rpc<{ accepted: boolean; extended: boolean; endsAt: number }>('bid', { auctionId: target.id, userId: 'sniper-' + run, amount: target.currentPrice + target.minIncrement, requestId: 'snipe-' + run })
  console.log('anti-snipe extended:', ext.extended, '| delta(ms):', ext.endsAt - target.endsAt, '(expect ~30000)')
  const dup = await rpc<{ accepted: boolean; code: string }>('bid', { auctionId: target.id, userId: 'sniper-' + run, amount: target.currentPrice + target.minIncrement, requestId: 'snipe-' + run })
  console.log('replay ->', dup.code, '(expect DUPLICATE)')
  // burst 50 at same price on the same auction
  const a2 = await rpc<{ auction: { currentPrice: number; status: string } }>('auction:get', { id: target.id })
  const rs = await Promise.all(Array.from({ length: 50 }, (_, i) =>
    rpc<{ accepted: boolean; code: string }>('bid', { auctionId: target.id, userId: 'b' + run + i, amount: a2.auction.currentPrice + 1, requestId: `burst-${run}-${i}` })))
  const acc = rs.filter(r => r.accepted)
  console.log('burst accepted:', acc.length, '(expect 1)', '| others:', rs.find(r => !r.accepted)?.code)
  socket.close(); process.exit(0)
})
socket.on('connect_error', (e) => { console.error('connect_error', e.message); process.exit(1) })
