import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { useChat } from '../context/ChatContext'
import { listMessages, sendMessage, searchUsers } from '../api/chat'

const MESSAGE_PAGE_SIZE = 50
const SCROLL_BOTTOM_THRESHOLD = 80
const SCROLL_TOP_LOAD_THRESHOLD = 60

function initials(nameOrEmail) {
  const source = (nameOrEmail || '').trim()
  if (!source) return '?'
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return source.slice(0, 2).toUpperCase()
}

function isSameDay(a, b) {
  return a.toDateString() === b.toDateString()
}

function formatDayLabel(dateStr, t, language) {
  const d = new Date(dateStr)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (isSameDay(d, today)) return t('chat.today')
  if (isSameDay(d, yesterday)) return t('chat.yesterday')
  return d.toLocaleDateString(language === 'th' ? 'th-TH' : 'en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

function formatTime(dateStr, language) {
  return new Date(dateStr).toLocaleTimeString(language === 'th' ? 'th-TH' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatListTimestamp(dateStr, language) {
  const d = new Date(dateStr)
  const today = new Date()
  if (isSameDay(d, today)) return formatTime(dateStr, language)
  return d.toLocaleDateString(language === 'th' ? 'th-TH' : 'en-US', { day: 'numeric', month: 'short' })
}

export function ChatPage() {
  const { conversationId: conversationIdParam } = useParams()
  const navigate = useNavigate()
  const { token, user } = useAuth()
  const { t, language } = useLanguage()
  const {
    conversations,
    loading: conversationsLoading,
    error: conversationsError,
    connectionState,
    subscribeToConversation,
    markConversationRead,
    startChat,
  } = useChat()

  const activeConversationId = conversationIdParam ? Number(conversationIdParam) : null
  const activeConversation = conversations.find((c) => c.id === activeConversationId) || null

  // -- Search-to-start ------------------------------------------------------
  const [query, setQuery] = useState('')
  const [userResults, setUserResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [startError, setStartError] = useState(null)

  const filteredConversations = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = !q
      ? conversations
      : conversations.filter((c) => {
          const name = (c.otherUser.name || '').toLowerCase()
          const email = c.otherUser.email.toLowerCase()
          return name.includes(q) || email.includes(q)
        })
    return [...list].sort(
      (a, b) => new Date(b.lastMessageAt ?? b.createdAt) - new Date(a.lastMessageAt ?? a.createdAt)
    )
  }, [conversations, query])

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setUserResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    const handle = setTimeout(() => {
      searchUsers(q, token)
        .then(setUserResults)
        .catch(() => setUserResults([]))
        .finally(() => setSearching(false))
    }, 300)
    return () => clearTimeout(handle)
  }, [query, token])

  const visibleUserResults = useMemo(() => {
    const shownIds = new Set(filteredConversations.map((c) => c.otherUser.id))
    return userResults.filter((u) => !shownIds.has(u.id))
  }, [userResults, filteredConversations])

  // Each section heading only earns its place when something sits under it —
  // "People / No matches found" above a list of matched conversations reads as
  // if the search failed. When neither side matches, one message covers both.
  const trimmedQuery = query.trim()
  const showPeopleSection = Boolean(trimmedQuery) && (searching || visibleUserResults.length > 0)
  const showConversationsHeading = Boolean(trimmedQuery) && filteredConversations.length > 0
  const showNoMatches =
    Boolean(trimmedQuery) &&
    !searching &&
    visibleUserResults.length === 0 &&
    filteredConversations.length === 0

  async function handleStartChat(targetUser) {
    setStartError(null)
    try {
      const summary = await startChat(targetUser.id)
      setQuery('')
      setUserResults([])
      navigate(`/chat/${summary.id}`)
    } catch (err) {
      setStartError(err.message)
    }
  }

  // -- Thread: messages -----------------------------------------------------
  const [messages, setMessages] = useState([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [messagesError, setMessagesError] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [nextBefore, setNextBefore] = useState(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [draft, setDraft] = useState('')

  const messagesElRef = useRef(null)
  const isAtBottomRef = useRef(true)

  const scrollToBottom = useCallback(() => {
    const el = messagesElRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  useEffect(() => {
    if (!activeConversationId) {
      setMessages([])
      setHasMore(false)
      setNextBefore(null)
      return
    }
    let cancelled = false
    setMessagesLoading(true)
    setMessagesError(null)
    listMessages(activeConversationId, { limit: MESSAGE_PAGE_SIZE }, token)
      .then((res) => {
        if (cancelled) return
        setMessages([...res.data].reverse())
        setHasMore(res.hasMore)
        setNextBefore(res.nextBefore)
        isAtBottomRef.current = true
        requestAnimationFrame(scrollToBottom)
      })
      .catch((err) => {
        if (!cancelled) setMessagesError(err.message)
      })
      .finally(() => {
        if (!cancelled) setMessagesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeConversationId, token, scrollToBottom])

  // Mark read whenever a thread is opened (or switched to).
  useEffect(() => {
    if (activeConversationId) markConversationRead(activeConversationId)
  }, [activeConversationId, markConversationRead])

  // Live updates for the currently-open thread.
  useEffect(() => {
    if (!activeConversationId) return undefined
    return subscribeToConversation(activeConversationId, (payload) => {
      setMessages((prev) => {
        if (prev.some((m) => m.id === payload.id)) return prev
        if (payload.senderId === user.id) {
          const pendingIdx = prev.findIndex((m) => m.pending && m.body === payload.body)
          if (pendingIdx !== -1) {
            const next = [...prev]
            next[pendingIdx] = payload
            return next
          }
        }
        return [...prev, payload]
      })
      if (payload.senderId !== user.id) {
        markConversationRead(activeConversationId)
      }
      if (isAtBottomRef.current || payload.senderId === user.id) {
        requestAnimationFrame(scrollToBottom)
      }
    })
  }, [activeConversationId, subscribeToConversation, markConversationRead, user.id, scrollToBottom])

  async function loadOlder() {
    if (!hasMore || loadingOlder || nextBefore == null) return
    setLoadingOlder(true)
    const el = messagesElRef.current
    const prevScrollHeight = el?.scrollHeight ?? 0
    try {
      const res = await listMessages(activeConversationId, { before: nextBefore, limit: MESSAGE_PAGE_SIZE }, token)
      setMessages((prev) => [...[...res.data].reverse(), ...prev])
      setHasMore(res.hasMore)
      setNextBefore(res.nextBefore)
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevScrollHeight
      })
    } catch (err) {
      setMessagesError(err.message)
    } finally {
      setLoadingOlder(false)
    }
  }

  function handleScroll() {
    const el = messagesElRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    isAtBottomRef.current = distanceFromBottom < SCROLL_BOTTOM_THRESHOLD
    if (el.scrollTop < SCROLL_TOP_LOAD_THRESHOLD && hasMore && !loadingOlder && !messagesLoading) {
      loadOlder()
    }
  }

  async function attemptSend(conversationId, body, tempId) {
    try {
      const real = await sendMessage(conversationId, body, token)
      setMessages((prev) => {
        if (prev.some((m) => m.id === real.id)) return prev.filter((m) => m.id !== tempId)
        return prev.map((m) => (m.id === tempId ? real : m))
      })
    } catch {
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, pending: false, failed: true } : m)))
    }
  }

  function handleSend(e) {
    e.preventDefault()
    const body = draft.trim()
    if (!body || !activeConversationId || messagesLoading) return
    setDraft('')
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const optimistic = {
      id: tempId,
      conversationId: activeConversationId,
      senderId: user.id,
      body,
      createdAt: new Date().toISOString(),
      pending: true,
    }
    setMessages((prev) => [...prev, optimistic])
    isAtBottomRef.current = true
    requestAnimationFrame(scrollToBottom)
    attemptSend(activeConversationId, body, tempId)
  }

  function handleRetry(tempId) {
    const msg = messages.find((m) => m.id === tempId)
    if (!msg) return
    setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, pending: true, failed: false } : m)))
    attemptSend(activeConversationId, msg.body, tempId)
  }

  const threadHeaderName = activeConversation
    ? activeConversation.otherUser.name || activeConversation.otherUser.email
    : t('common.loading')

  let lastDayKey = null

  return (
    <div>
      <h1>{t('chat.title')}</h1>

      <div className={`chat-layout${activeConversationId ? ' show-thread' : ''}`}>
        <div className="chat-list-pane">
          <div className="chat-search-wrap">
            <input
              type="search"
              className="search-input"
              placeholder={t('chat.searchPlaceholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="chat-list-scroll">
            {conversationsError && <p className="error">{t('chat.loadError')}</p>}
            {startError && <p className="error">{startError}</p>}

            {showPeopleSection && (
              <>
                <div className="chat-list-section-label">{t('chat.sectionPeople')}</div>
                {searching ? (
                  <p className="hint">{t('common.loading')}</p>
                ) : (
                  visibleUserResults.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      className="chat-user-result"
                      onClick={() => handleStartChat(u)}
                    >
                      <span className="chat-avatar">{initials(u.name || u.email)}</span>
                      <span className="chat-conversation-main">
                        <span className="chat-conversation-name">{u.name || u.email}</span>
                        {u.name && <span className="chat-conversation-preview">{u.email}</span>}
                      </span>
                      <span className="chat-user-result-sub">{u.role}</span>
                    </button>
                  ))
                )}
              </>
            )}

            {showConversationsHeading && (
              <div className="chat-list-section-label">{t('chat.sectionConversations')}</div>
            )}

            {conversationsLoading && conversations.length === 0 ? (
              <p className="hint">{t('common.loading')}</p>
            ) : filteredConversations.length === 0 ? (
              trimmedQuery ? (
                showNoMatches && <p className="hint">{t('chat.noResults')}</p>
              ) : (
                <div className="chat-empty">
                  <strong>{t('chat.noConversationsTitle')}</strong>
                  <span>{t('chat.noConversationsBody')}</span>
                </div>
              )
            ) : (
              filteredConversations.map((c) => {
                const name = c.otherUser.name || c.otherUser.email
                const unread = c.unreadCount > 0
                return (
                  <Link
                    key={c.id}
                    to={`/chat/${c.id}`}
                    className={`chat-conversation-row${c.id === activeConversationId ? ' active' : ''}${
                      unread ? ' unread' : ''
                    }`}
                  >
                    <span className="chat-avatar">{initials(name)}</span>
                    <span className="chat-conversation-main">
                      <span className={`chat-conversation-name${unread ? ' unread' : ''}`}>{name}</span>
                      <span className={`chat-conversation-preview${unread ? ' unread' : ''}`}>
                        {c.lastMessage ? c.lastMessage.body : t('chat.startNewChat')}
                      </span>
                    </span>
                    <span className="chat-conversation-meta">
                      <span className="chat-timestamp">
                        {formatListTimestamp(c.lastMessageAt ?? c.createdAt, language)}
                      </span>
                      {unread && (
                        <span className="chat-unread-badge">{c.unreadCount > 99 ? '99+' : c.unreadCount}</span>
                      )}
                    </span>
                  </Link>
                )
              })
            )}
          </div>
        </div>

        <div className="chat-thread-pane">
          {!activeConversationId ? (
            <div className="chat-thread-placeholder">
              <strong>{t('chat.selectConversationTitle')}</strong>
              <span>{t('chat.selectConversationBody')}</span>
            </div>
          ) : (
            <>
              <div className="chat-thread-header">
                <button
                  type="button"
                  className="chat-thread-back"
                  aria-label={t('chat.backToList')}
                  onClick={() => navigate('/chat')}
                >
                  ←
                </button>
                <span className="chat-avatar sm">{initials(threadHeaderName)}</span>
                <span className="chat-thread-header-name">{threadHeaderName}</span>
              </div>

              {connectionState !== 'connected' && (
                <div className={`chat-stream-banner${connectionState === 'down' ? ' down' : ''}`}>
                  <span>{connectionState === 'down' ? t('chat.disconnected') : t('chat.reconnecting')}</span>
                  {connectionState === 'down' && (
                    <button type="button" onClick={() => window.location.reload()}>
                      {t('chat.reconnectNow')}
                    </button>
                  )}
                </div>
              )}

              <div className="chat-messages" ref={messagesElRef} onScroll={handleScroll}>
                {messagesError && <p className="error">{messagesError}</p>}
                {hasMore && (
                  <button type="button" className="chat-load-more" onClick={loadOlder} disabled={loadingOlder}>
                    {loadingOlder ? t('common.loading') : t('chat.loadOlder')}
                  </button>
                )}
                {messagesLoading ? (
                  <p className="hint">{t('chat.loadingMessages')}</p>
                ) : (
                  messages.map((m) => {
                    const dayKey = new Date(m.createdAt).toDateString()
                    const showSeparator = dayKey !== lastDayKey
                    lastDayKey = dayKey
                    const mine = m.senderId === user.id
                    return (
                      <div key={m.id}>
                        {showSeparator && (
                          <div className="chat-date-separator">
                            <span>{formatDayLabel(m.createdAt, t, language)}</span>
                          </div>
                        )}
                        <div className={`chat-bubble-row ${mine ? 'mine' : 'theirs'}${m.failed ? ' failed' : ''}`}>
                          <div>
                            <div className="chat-bubble">
                              {m.body}
                              <span className="chat-bubble-time">{formatTime(m.createdAt, language)}</span>
                            </div>
                            {m.failed && (
                              <div className="chat-bubble-error">
                                <span>{t('chat.messageFailed')}</span>
                                <button
                                  type="button"
                                  className="chat-retry-btn"
                                  onClick={() => handleRetry(m.id)}
                                >
                                  {t('chat.retrySend')}
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>

              <form className="chat-composer" onSubmit={handleSend}>
                <input
                  type="text"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={t('chat.composerPlaceholder')}
                  maxLength={4000}
                />
                <button type="submit" disabled={!draft.trim() || messagesLoading}>
                  {t('chat.send')}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
