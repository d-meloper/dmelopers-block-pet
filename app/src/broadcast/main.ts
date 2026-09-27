import { createBroadcastSession } from '@/features/broadcast/session'

import { installBroadcastDiagnostics } from './diagnostics'
import { createBroadcastView } from './view'

const base = new URL('./', location.href)
let socket: WebSocket | undefined
const diagnostics = installBroadcastDiagnostics((code) => {
  if (socket?.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify({ type: 'diagnostic', code }))
  return true
})
const view = createBroadcastView(document.body, base)
let reconnect: ReturnType<typeof setTimeout> | undefined
let lastMessage = Date.now()
let disposed = false
const session = createBroadcastSession({
  ...view,
  ready: (revision) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ready', revision }))
  },
  failed: (revision) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'render_error', revision }))
  },
})

function connect() {
  if (disposed) return
  const url = new URL('ws', base)
  url.protocol = 'ws:'
  const connection = new WebSocket(url)
  socket = connection
  lastMessage = Date.now()
  connection.onopen = () => {
    if (socket === connection) diagnostics.flush()
  }
  connection.onmessage = ({ data }) => {
    if (socket !== connection || typeof data !== 'string' || data.length > 4 * 1024 * 1024) return
    lastMessage = Date.now()
    try {
      session.receive(JSON.parse(data))
    } catch {
      diagnostics.report('server_message_invalid')
      connection.close()
    }
  }
  connection.onerror = () => connection.close()
  connection.onclose = () => {
    if (socket !== connection) return
    session.disconnect()
    socket = undefined
    if (!disposed) reconnect = setTimeout(connect, 1500)
  }
}

const heartbeat = setInterval(() => {
  if (socket && Date.now() - lastMessage > 8000) {
    diagnostics.report('heartbeat_timeout')
    session.disconnect()
    socket.close()
  }
}, 2000)
window.addEventListener('pagehide', () => {
  disposed = true
  clearTimeout(reconnect)
  clearInterval(heartbeat)
  session.disconnect()
  socket?.close()
  view.dispose()
  diagnostics.dispose()
}, { once: true })
connect()
