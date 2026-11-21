import { io } from 'socket.io-client'
const run = Math.random().toString(36).slice(2, 8)
const socket = io('http://localhost:3002', { transports: ['websocket'] })
const rpc = <T>(e: string, p?: unknown): Promise<T> =>
  new Promise((res, rej) => socket.timeout(5000).emit(e, p, (err: unknown, r: T) => err ? rej(err) : res(r)))
socket.on('connect', async () => {
  // anti-snipe on hot-1
  const before = await rpc<{ auction: { endsAt: number; currentPrice: number; minIncrement: number } }>('auction:get', { id: 'hot-1' })
  const a = before.auction
  const ext = await rpc<{ accepted: boolean; extended: boolean; endsAt: number }>('bid', { auctionId: 'hot-1', userId: 'sniper-' + run, amount: a.currentPrice + a.minIncrement, requestId: 'snipe-' + run })
  console.log('anti-snipe extended:', ext.extended, '| delta(ms):', ext.endsAt - a.endsAt, '(expect ~30000)')
  // duplicate replay
  const dup = await rpc<{ accepted: boolean; code: string }>('bid', { auctionId: 'hot-1', userId: 'sniper-' + run, amount: a.currentPrice + a.minIncrement, requestId: 'snipe-' + run })
  console.log('replay ->', dup.code, '(expect DUPLICATE)')
  // burst 50 same price
  const rs = await Promise.all(Array.from({ length: 50 }, (_, i) =>
    rpc<{ accepted: boolean }>('bid', { auctionId: 'hot-2', userId: 'b' + run + i, amount: 999999 + i * 0.001, requestId: `burst-${run}-${i}` })))
  console.log('burst accepted:', rs.filter(r => r.accepted).length, '(expect 1)')
  socket.close(); process.exit(0)
})
