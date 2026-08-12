import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from './AuthContext'
import { useStream } from './StreamContext'
import { listConversations, startConversation, markRead as markReadApi } from '../api/chat'

const ChatContext = createContext(null)

export function ChatProvider({ children }) {
  const { token, user } = useAuth()
  // The SSE connection itself lives in StreamContext — chat is one of two
  // subscribers to it now, not its owner. `connectionState` is re-exported
  // below so ChatPage's reconnecting/disconnected banner keeps working
  // unchanged; it reports the shared connection's health, which is the same
  // thing it always meant to the user.
  const { connectionState, subscribe } = useStream()

  const [conversations, setConversations] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const listenersRef = useRef(new Map()) // conversationId -> Set<(payload) => void>
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

  useEffect(() => subscribe('message', handleIncomingMessage), [subscribe, handleIncomingMessage])

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
