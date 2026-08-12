import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from './AuthContext'
import { listConversations, startConversation, markRead as markReadApi, getStreamTicket } from '../api/chat'

const ChatContext = createContext(null)

// Reconnect backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s. After a handful of
// failed attempts we report `down` instead of `reconnecting` so the banner
// can escalate to the danger palette per the design spec.
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000
const DOWN_AFTER_ATTEMPTS = 4

export function ChatProvider({ children }) {
  const { token, user } = useAuth()

  const [conversations, setConversations] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [connectionState, setConnectionState] = useState('reconnecting')

  const listenersRef = useRef(new Map()) // conversationId -> Set<(payload) => void>
  const esRef = useRef(null)
  const attemptRef = useRef(0)
  const retryTimerRef = useRef(null)
  const stoppedRef = useRef(true)
  const userIdRef = useRef(user?.id)
  userIdRef.current = user?.id

  const refreshConversations = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const data = await listConversations(token)
      setConversations(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    if (!token) {
      setConversations([])
      return
    }
    refreshConversations()
  }, [token, refreshConversations])

  // Thread views subscribe here to receive live messages for the
  // conversation they have open, without the context needing to know
  // anything about the currently-mounted route/component.
  const subscribeToConversation = useCallback((conversationId, callback) => {
    const map = listenersRef.current
    if (!map.has(conversationId)) map.set(conversationId, new Set())
    map.get(conversationId).add(callback)
    return () => {
      map.get(conversationId)?.delete(callback)
    }
  }, [])

  const handleIncomingMessage = useCallback((payload) => {
    listenersRef.current.get(payload.conversationId)?.forEach((cb) => cb(payload))

    setConversations((prev) => {
      const idx = prev.findIndex((c) => c.id === payload.conversationId)
      if (idx === -1) {
        // A message for a conversation we don't have cached yet (e.g. the
        // very first message of a brand-new conversation someone else
        // started with us) — refetch to pick up the new row with its
        // otherUser/unreadCount rather than trying to fabricate it here.
        refreshConversations()
        return prev
      }
      const isMine = payload.senderId === userIdRef.current
      const next = [...prev]
      const conv = next[idx]
      next[idx] = {
        ...conv,
        lastMessage: payload,
        lastMessageAt: payload.createdAt,
        unreadCount: isMine ? conv.unreadCount : conv.unreadCount + 1,
      }
      return next
    })
  }, [refreshConversations])

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
    es.addEventListener('message', (evt) => {
      try {
        handleIncomingMessage(JSON.parse(evt.data))
      } catch {
        // ignore malformed payloads
      }
    })
    es.onerror = () => {
      es.close()
      if (esRef.current === es) esRef.current = null
      scheduleReconnect()
    }
  }, [token, handleIncomingMessage, scheduleReconnect])
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

  const markConversationRead = useCallback(
    async (conversationId) => {
      setConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, unreadCount: 0 } : c)))
      try {
        await markReadApi(conversationId, token)
      } catch {
        // Non-critical — the badge may drift until the next full refresh.
      }
    },
    [token]
  )

  const startChat = useCallback(
    async (userId) => {
      const summary = await startConversation(userId, token)
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.id === summary.id)
        if (idx !== -1) {
          const next = [...prev]
          next[idx] = { ...next[idx], otherUser: summary.otherUser, lastMessageAt: summary.lastMessageAt }
          return next
        }
        return [{ ...summary, lastMessage: null, unreadCount: 0 }, ...prev]
      })
      return summary
    },
    [token]
  )

  const unreadTotal = useMemo(
    () => conversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0),
    [conversations]
  )

  const value = useMemo(
    () => ({
      conversations,
      loading,
      error,
      connectionState,
      unreadTotal,
      refreshConversations,
      subscribeToConversation,
      markConversationRead,
      startChat,
    }),
    [
      conversations,
      loading,
      error,
      connectionState,
      unreadTotal,
      refreshConversations,
      subscribeToConversation,
      markConversationRead,
      startChat,
    ]
  )

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}

export function useChat() {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error('useChat must be used within a ChatProvider')
  return ctx
}
