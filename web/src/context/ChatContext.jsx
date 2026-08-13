import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from './AuthContext'
import { listConversations, startConversation, markRead as markReadApi, getStreamTicket } from '../api/chat'

const ChatContext = createContext(null)

// Shared by every per-conversation event map below (typing, message-edited,
// message-deleted) — each is otherwise an identical "Map<conversationId,
// Set<callback>>" registry, just fed by a different SSE event name.
function subscribeViaMap(map, key, callback) {
  if (!map.has(key)) map.set(key, new Set())
  map.get(key).add(callback)
  return () => {
    map.get(key)?.delete(callback)
  }
}

function dispatchViaMap(map, key, payload) {
  map.get(key)?.forEach((cb) => cb(payload))
}

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
  // 'connecting' (first attempt, nothing to warn about yet) is distinct from
  // 'reconnecting' (a live connection just dropped) so the UI only shows a
  // banner once something has actually gone wrong — a brand-new page load
  // isn't a reconnect. See connect()/scheduleReconnect() below for exactly
  // when each fires.
  const [connectionState, setConnectionState] = useState('connecting')

  const listenersRef = useRef(new Map()) // conversationId -> Set<(payload) => void>
  const typingListenersRef = useRef(new Map()) // conversationId -> Set<(payload) => void>
  const editedListenersRef = useRef(new Map()) // conversationId -> Set<(payload) => void>
  const deletedListenersRef = useRef(new Map()) // conversationId -> Set<(payload) => void>
  const friendListenersRef = useRef(new Set())
  const esRef = useRef(null)
  const attemptRef = useRef(0)
  const retryTimerRef = useRef(null)
  const stoppedRef = useRef(true)
  // Bumped by the token-change effect's cleanup, independent of stoppedRef:
  // stoppedRef gets reset to false again as soon as the new effect run
  // starts, so an old connect() still resuming from an in-flight ticket
  // fetch would otherwise pass that check and open an EventSource with a
  // stale ticket for the previous session. Each connect() call captures the
  // epoch it started under and re-checks it after every await.
  const epochRef = useRef(0)
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
  const subscribeToConversation = useCallback(
    (conversationId, callback) => subscribeViaMap(listenersRef.current, conversationId, callback),
    []
  )

  // Separate maps per event rather than one and a type tag on the payload —
  // each keeps its callback contract single-shaped (a typing payload isn't a
  // message, an edit isn't a delete), so a subscriber never has to branch on
  // event type to know what it received.
  const subscribeToTyping = useCallback(
    (conversationId, callback) => subscribeViaMap(typingListenersRef.current, conversationId, callback),
    []
  )
  const subscribeToMessageEdited = useCallback(
    (conversationId, callback) => subscribeViaMap(editedListenersRef.current, conversationId, callback),
    []
  )
  const subscribeToMessageDeleted = useCallback(
    (conversationId, callback) => subscribeViaMap(deletedListenersRef.current, conversationId, callback),
    []
  )

  // FriendsContext hooks in here rather than opening a second SSE
  // connection/ticket of its own — the server forwards a "friend" event over
  // this same stream (src/routes/friends.js#publishFriendEvent) whenever a
  // request arrives or gets accepted, and every listener just wants to know
  // "something changed, refetch," not the payload details.
  const subscribeToFriendEvents = useCallback((callback) => {
    friendListenersRef.current.add(callback)
    return () => friendListenersRef.current.delete(callback)
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

  // Patches the other participant's last-read timestamp in place on a live
  // "read" event, so an open thread's "Read" tick updates without a refetch
  // — see GET /conversations's otherLastReadAt (src/routes/chat.js).
  const updateOtherLastReadAt = useCallback((conversationId, lastReadAt) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === conversationId ? { ...c, otherLastReadAt: lastReadAt } : c))
    )
  }, [])

  // Keeps the conversation-list preview from showing stale/deleted text
  // after an edit or delete of whichever message it was last showing —
  // patches only when the edited/deleted id is actually the cached preview.
  const updateCachedLastMessage = useCallback((conversationId, messageId, patch) => {
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== conversationId || c.lastMessage?.id !== messageId) return c
        return { ...c, lastMessage: { ...c.lastMessage, ...patch } }
      })
    )
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
    const myEpoch = epochRef.current
    if (stoppedRef.current) return
    // attemptRef is only ever incremented by scheduleReconnect, i.e. after a
    // real failure — so still being at 0 here means this is the first-ever
    // attempt for this token, not a reconnect.
    setConnectionState((s) => (s === 'connected' ? s : attemptRef.current === 0 ? 'connecting' : 'reconnecting'))
    let ticket
    try {
      ;({ ticket } = await getStreamTicket(token))
    } catch {
      if (myEpoch === epochRef.current) scheduleReconnect()
      return
    }
    if (stoppedRef.current || myEpoch !== epochRef.current) return

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
    es.addEventListener('typing', (evt) => {
      try {
        const payload = JSON.parse(evt.data)
        dispatchViaMap(typingListenersRef.current, payload.conversationId, payload)
      } catch {
        // ignore malformed payloads
      }
    })
    es.addEventListener('message-edited', (evt) => {
      try {
        const payload = JSON.parse(evt.data)
        dispatchViaMap(editedListenersRef.current, payload.conversationId, payload)
        updateCachedLastMessage(payload.conversationId, payload.id, { body: payload.body, editedAt: payload.editedAt })
      } catch {
        // ignore malformed payloads
      }
    })
    es.addEventListener('message-deleted', (evt) => {
      try {
        const payload = JSON.parse(evt.data)
        dispatchViaMap(deletedListenersRef.current, payload.conversationId, payload)
        updateCachedLastMessage(payload.conversationId, payload.id, { body: null, deletedAt: payload.deletedAt })
      } catch {
        // ignore malformed payloads
      }
    })
    es.addEventListener('read', (evt) => {
      try {
        const payload = JSON.parse(evt.data)
        updateOtherLastReadAt(payload.conversationId, payload.lastReadAt)
      } catch {
        // ignore malformed payloads
      }
    })
    es.addEventListener('friend', (evt) => {
      try {
        const payload = JSON.parse(evt.data)
        friendListenersRef.current.forEach((cb) => cb(payload))
      } catch {
        // ignore malformed payloads
      }
    })
    es.onerror = () => {
      es.close()
      if (esRef.current === es) esRef.current = null
      scheduleReconnect()
    }
  }, [token, handleIncomingMessage, updateCachedLastMessage, updateOtherLastReadAt, scheduleReconnect])
  connectRef.current = connect

  useEffect(() => {
    clearTimeout(retryTimerRef.current)
    esRef.current?.close()
    esRef.current = null
    attemptRef.current = 0

    if (!token) {
      stoppedRef.current = true
      setConnectionState('connecting')
      return
    }

    stoppedRef.current = false
    connect()

    return () => {
      stoppedRef.current = true
      epochRef.current += 1
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
      subscribeToTyping,
      subscribeToMessageEdited,
      subscribeToMessageDeleted,
      subscribeToFriendEvents,
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
      subscribeToTyping,
      subscribeToMessageEdited,
      subscribeToMessageDeleted,
      subscribeToFriendEvents,
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
