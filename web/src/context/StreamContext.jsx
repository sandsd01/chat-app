import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from './AuthContext'
import { getStreamTicket } from '../api/chat'

const StreamContext = createContext(null)

// Reconnect backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s. After a handful of
// failed attempts we report `down` instead of `reconnecting` so the banner
// can escalate to the danger palette per the design spec.
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000
const DOWN_AFTER_ATTEMPTS = 4

// Every named event the server sends on this stream. EventSource has no
// wildcard listener, and the instance is thrown away and rebuilt on every
// reconnect, so subscribers can't be registered against it directly: each new
// connection attaches one dispatcher per name here, while the subscribers
// themselves live in a ref that survives reconnects untouched. A new
// server-side event means adding its name to this list — subscribing to a
// name that isn't here silently never fires.
const STREAM_EVENTS = ['message', 'friend']

// Owns the single SSE connection for the whole app. Chat and Friends both
// subscribe to it rather than each opening their own: one connection per tab,
// and neither context has to depend on the other to get at it.
export function StreamProvider({ children }) {
  const { token } = useAuth()

  const [connectionState, setConnectionState] = useState('reconnecting')

  const listenersRef = useRef(new Map()) // eventName -> Set<(payload) => void>
  const esRef = useRef(null)
  const attemptRef = useRef(0)
  const retryTimerRef = useRef(null)
  const stoppedRef = useRef(true)

  const subscribe = useCallback((eventName, callback) => {
    const map = listenersRef.current
    if (!map.has(eventName)) map.set(eventName, new Set())
    map.get(eventName).add(callback)
    return () => {
      map.get(eventName)?.delete(callback)
    }
  }, [])

  // `scheduleReconnect` and `connect` call each other; a ref sidesteps the
  // definition-order/exhaustive-deps tangle a direct useCallback reference
  // would create between the two.
  const connectRef = useRef(() => {})

  const scheduleReconnect = useCallback(() => {
    if (stoppedRef.current) return
    attemptRef.current += 1
    setConnectionState(attemptRef.current >= DOWN_AFTER_ATTEMPTS ? 'down' : 'reconnecting')
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attemptRef.current - 1))
    clearTimeout(retryTimerRef.current)
    retryTimerRef.current = setTimeout(() => connectRef.current(), delay)
  }, [])

  const connect = useCallback(async () => {
    if (stoppedRef.current) return
    setConnectionState((s) => (s === 'connected' ? s : 'reconnecting'))
    let ticket
    try {
      ;({ ticket } = await getStreamTicket(token))
    } catch {
      scheduleReconnect()
      return
    }
    if (stoppedRef.current) return

    const es = new EventSource(`/api/chat/stream?ticket=${encodeURIComponent(ticket)}`)
    esRef.current = es

    es.onopen = () => {
      attemptRef.current = 0
      setConnectionState('connected')
    }

    for (const eventName of STREAM_EVENTS) {
      es.addEventListener(eventName, (evt) => {
        let payload
        try {
          payload = JSON.parse(evt.data)
        } catch {
          return // ignore malformed payloads
        }
        listenersRef.current.get(eventName)?.forEach((cb) => cb(payload))
      })
    }

    es.onerror = () => {
      es.close()
      if (esRef.current === es) esRef.current = null
      scheduleReconnect()
    }
  }, [token, scheduleReconnect])
  connectRef.current = connect

  useEffect(() => {
    clearTimeout(retryTimerRef.current)
    esRef.current?.close()
    esRef.current = null
    attemptRef.current = 0

    if (!token) {
      stoppedRef.current = true
      setConnectionState('reconnecting')
      return
    }

    stoppedRef.current = false
    connect()

    return () => {
      stoppedRef.current = true
      clearTimeout(retryTimerRef.current)
      esRef.current?.close()
      esRef.current = null
    }
    // Reconnect whenever the session changes (login/logout); `connect` itself
    // is stable enough per-token via its own dependency array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const value = useMemo(() => ({ connectionState, subscribe }), [connectionState, subscribe])

  return <StreamContext.Provider value={value}>{children}</StreamContext.Provider>
}

export function useStream() {
  const ctx = useContext(StreamContext)
  if (!ctx) throw new Error('useStream must be used within a StreamProvider')
  return ctx
}
