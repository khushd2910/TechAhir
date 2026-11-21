import { io } from 'socket.io-client'

const socket = io('http://localhost:3002', { transports: ['websocket'] })
const rpc = <T>(event: string, payload?: unknown): Promise<T> =>
  new Promise((resolve, reject) => {
    socket.timeout(5000).emit(event, payload, (err: unknown, res: T) => {
      if (err) reject(err)
      else resolve(res as T)
    })
  })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

socket.on('connect', async () => {
  console.log('connected:', socket.id)
  const list = await rpc<{ auctions: Array<{ id: string; currentPrice: number; minIncrement: number; endsAt: number; status: string }> }>('auction:list', { page: 1, limit: 5 })
  const a = list.auctions[0]
  console.log('list ok, first:', a.id, a.currentPrice)

  // 1) low bid rejected
  const low = await rpc<{ accepted: boolean; code: string; minRequired: number }>('bid', { auctionId: a.id, userId: 'test-user', amount: a.currentPrice, requestId: 't1' })
  console.log('low bid ->', low.code, 'minRequired:', low.minRequired)

  // 2) valid bid accepted
  const good = await rpc<{ accepted: boolean; code: string; price: number; extended: boolean }>('bid', { auctionId: a.id, userId: 'test-user', userName: 'Tester', amount: a.currentPrice + a.minIncrement, requestId: 't2' })
  console.log('good bid ->', good.code, 'price:', good.price, 'extended:', good.extended)

  // 3) duplicate requestId rejected
  const dup = await rpc<{ accepted: boolean; code: string }>('bid', { auctionId: a.id, userId: 'test-user', amount: a.currentPrice + a.minIncrement, requestId: 't2' })
  console.log('duplicate ->', dup.code)

  // 4) concurrent burst: 50 bids at the SAME price -> exactly 1 accepted
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      rpc<{ accepted: boolean; code: string }>('bid', { auctionId: a.id, userId: `burst-${i}`, amount: a.currentPrice + a.minIncrement, requestId: `burst-${i}` }),
    ),
  )
  const winners = results.filter((r) => r.accepted)
  console.log('burst: accepted =', winners.length, '| winner =', winners[0]?.code)

  // 5) anti-snipe: bid on hot auction near deadline
  const before = await rpc<{ auction: { endsAt: number } }>('auction:get', { id: 'hot-0' })
  const endsBefore = before.auction.endsAt
  const detail = await rpc<{ auction: { currentPrice: number; minIncrement: number } }>('auction:get', { id: 'hot-0' })
  const hot = detail.auction
  const ext = await rpc<{ accepted: boolean; extended: boolean; endsAt: number }>('bid', { auctionId: 'hot-0', userId: 'sniper', amount: hot.currentPrice + hot.minIncrement, requestId: 't3' })
  console.log('anti-snipe -> extended:', ext.extended, 'delta(ms):', ext.endsAt - endsBefore)

  // 6) settlement: wait for any hot auction to expire naturally
  console.log('waiting for a settlement...')
  for (let i = 0; i < 30; i++) {
    await sleep(2000)
    const st = await rpc<{ settled: number }>('auction:stats')
    if (st.settled > 0) {
      console.log('settled auctions:', st.settled, '-> settlement works')
      break
    }
  }
  socket.close()
  process.exit(0)
})
socket.on('connect_error', (e) => { console.error('connect_error', e.message); process.exit(1) })
