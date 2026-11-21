import { io } from 'socket.io-client'
const socket = io('http://localhost:3002', { transports: ['websocket'] })
socket.on('connect', async () => {
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now()
    await new Promise<void>((resolve) => {
      socket.timeout(5000).emit('auction:stats', (err: unknown, res: { settled: number }) => {
        console.log(i, err ? 'ERR ' + (err as Error).message : 'ok settled=' + res.settled, Date.now() - t0 + 'ms')
        resolve()
      })
    })
  }
  process.exit(0)
})
