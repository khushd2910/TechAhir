import { io } from 'socket.io-client'
const s = io('http://localhost:3002', { transports: ['websocket'] })
s.on('connect', () => {
  s.timeout(8000).emit('load:start', { targetBps: 3000, durationSec: 6 }, () => {})
  setTimeout(() => {
    s.timeout(8000).emit('auction:stats', {}, (err: unknown, st: { load: { accepted: number; rejected: number; avgLatencyMs: number }; bidsAccepted: number }) => {
      if (!err) console.log('6s run ->', st.load.accepted, 'accepted,', st.load.rejected, 'rejected, avg latency', st.load.avgLatencyMs, 'ms')
      s.close(); process.exit(0)
    })
  }, 7000)
})
