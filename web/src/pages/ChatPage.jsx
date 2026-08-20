import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { useChat } from '../context/ChatContext'
import { useFriends } from '../context/FriendsContext'
import {
  listMessages,
  sendMessage,
  requestUpload,
  uploadFileToR2,
  sendTyping,
  editMessage,
  deleteMessage,
  searchMessages,
  addReaction,
  removeReaction,
  exportConversation,
} from '../api/chat'
import { EmojiPicker } from '../components/EmojiPicker'
import LinkPreviewCard from '../components/LinkPreviewCard'
import { localeFor, CLEARED_ATTACHMENT_FIELDS } from '../lib/format'
import { linkifyText } from '../lib/linkify'
import { Avatar } from '../components/Avatar'
import { useDocumentTitle } from '../hooks/useDocumentTitle'

// Must stay in step with DISAPPEARING_SECONDS in src/routes/chat.js, which
// validates against its own fixed set — the server rejects anything else.
const DISAPPEARING_OPTIONS = [300, 3600, 86400, 604800]

const MESSAGE_PAGE_SIZE = 50
const SCROLL_BOTTOM_THRESHOLD = 80
const SCROLL_TOP_LOAD_THRESHOLD = 60

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
  return d.toLocaleDateString(localeFor(language), { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatTime(dateStr, language) {
  return new Date(dateStr).toLocaleTimeString(localeFor(language), { hour: '2-digit', minute: '2-digit' })
}

function formatListTimestamp(dateStr, language) {
  const d = new Date(dateStr)
  const today = new Date()
  if (isSameDay(d, today)) return formatTime(dateStr, language)
  return d.toLocaleDateString(localeFor(language), { day: 'numeric', month: 'short' })
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
    subscribeToTyping,
    subscribeToMessageEdited,
    subscribeToMessageDeleted,
    subscribeToReactionAdded,
    subscribeToReactionRemoved,
    subscribeToLinkPreview,
    subscribeToMessageExpired,
    markConversationRead,
    setConversationMuted,
    setConversationPinned,
    changeDisappearing,
    startChat,
  } = useChat()
  const { friends } = useFriends()

  const activeConversationId = conversationIdParam ? Number(conversationIdParam) : null
  const activeConversation = conversations.find((c) => c.id === activeConversationId) || null

  // -- Search-to-start --------------------------------------------------------
  // "People to message" is now exactly your friends list (see friends.js /
  // FriendsPage — you must already be friends to start a conversation), so
  // this is a client-side filter against data already loaded, not a server
  // search hitting a directory of every registered user.
  const [query, setQuery] = useState('')
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
    // Pinned-first, matching GET /conversations' own sort — the list here is
    // re-sorted after every optimistic update (e.g. searching), so it has to
    // reapply the same rule rather than just trusting the fetch order.
    return [...list].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return new Date(b.lastMessageAt ?? b.createdAt) - new Date(a.lastMessageAt ?? a.createdAt)
    })
  }, [conversations, query])

  const visibleFriends = useMemo(() => {
    const q = query.trim().toLowerCase()
    const shownIds = new Set(filteredConversations.map((c) => c.otherUser.id))
    return friends
      .map((f) => f.otherUser)
      .filter((u) => !shownIds.has(u.id))
      .filter((u) => {
        if (!q) return false // only surface "start a new chat" once the user is searching
        const name = (u.name || '').toLowerCase()
        return name.includes(q) || u.email.toLowerCase().includes(q)
      })
  }, [friends, filteredConversations, query])

  // Each section heading only earns its place when something sits under it —
  // "Friends / No matches found" above a list of matched conversations reads
  // as if the search failed. When neither side matches, one message covers both.
  const trimmedQuery = query.trim()
  const showFriendsSection = Boolean(trimmedQuery) && visibleFriends.length > 0
  const showConversationsHeading = Boolean(trimmedQuery) && filteredConversations.length > 0
  const showNoMatches =
    Boolean(trimmedQuery) && visibleFriends.length === 0 && filteredConversations.length === 0

  async function handleStartChat(targetUser) {
    setStartError(null)
    try {
      const summary = await startChat(targetUser.id)
      setQuery('')
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
  // Tracked separately from hasMore/nextBefore: only consulted once
  // Postgres's own hasMore goes false, and reset per-conversation the same
  // way (see the load effect below).
  const [loadingOlder, setLoadingOlder] = useState(false)
  // Announced through a visually-hidden live region below — loadOlder()
  // prepends messages above the current scroll position with no visible
  // change a screen-reader user would otherwise notice.
  const [olderLoadAnnouncement, setOlderLoadAnnouncement] = useState('')
  const [draft, setDraft] = useState('')
  const [editingMessageId, setEditingMessageId] = useState(null)
  const [editingDraft, setEditingDraft] = useState('')
  // Holds the message being quoted, not just its id — the composer banner
  // needs to show who/what without a lookup, and the message stays
  // available even if it scrolls out of the loaded page while replying.
  const [replyingTo, setReplyingTo] = useState(null)
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false)
  const [reactionPickerMessageId, setReactionPickerMessageId] = useState(null)
  const [uploadBusy, setUploadBusy] = useState(false)
  const [uploadError, setUploadError] = useState(null)
  const fileInputRef = useRef(null)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportError, setExportError] = useState(null)

  const messagesElRef = useRef(null)
  const isAtBottomRef = useRef(true)

  // -- In-thread search -------------------------------------------------------
  // A separate result list rather than trying to scroll/highlight a match
  // inside the already-loaded thread: an older match may not be loaded into
  // the thread yet, so "jump to it in place" isn't always possible.
  // Debounced, and scoped to whichever conversation is open.
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState(null)
  const SEARCH_DEBOUNCE_MS = 300

  useEffect(() => {
    setSearchOpen(false)
    setSearchQuery('')
    setSearchResults(null)
    setSearchError(null)
  }, [activeConversationId])

  useEffect(() => {
    const q = searchQuery.trim()
    if (!searchOpen || !q) {
      setSearchResults(null)
      setSearchError(null)
      return undefined
    }
    setSearchLoading(true)
    const timer = setTimeout(() => {
      searchMessages(activeConversationId, { q, limit: 50 }, token)
        .then((res) => setSearchResults(res.data))
        .catch((err) => setSearchError(err.message))
        .finally(() => setSearchLoading(false))
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchOpen, searchQuery, activeConversationId, token])

  // -- Typing indicator ------------------------------------------------------
  // Transient presence only: no history, no persistence. "Other is typing"
  // clears itself on a timeout rather than waiting for a "stopped typing"
  // event, since the backend doesn't publish one (see src/routes/chat.js).
  const [otherTyping, setOtherTyping] = useState(false)
  const typingClearTimerRef = useRef(null)
  const lastTypingSentAtRef = useRef(0)
  const TYPING_CLEAR_MS = 3000
  const TYPING_SEND_THROTTLE_MS = 2000

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

  // Reset when switching threads so a stale indicator from the previous
  // conversation can't linger, then re-subscribe for the newly active one.
  useEffect(() => {
    setOtherTyping(false)
    setEditingMessageId(null)
    setEditingDraft('')
    setReactionPickerMessageId(null)
    clearTimeout(typingClearTimerRef.current)
    if (!activeConversationId) return undefined
    return subscribeToTyping(activeConversationId, () => {
      setOtherTyping(true)
      clearTimeout(typingClearTimerRef.current)
      typingClearTimerRef.current = setTimeout(() => setOtherTyping(false), TYPING_CLEAR_MS)
    })
  }, [activeConversationId, subscribeToTyping])

  useEffect(() => {
    if (!activeConversationId) return undefined
    return subscribeToMessageEdited(activeConversationId, (payload) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === payload.id ? { ...m, body: payload.body, editedAt: payload.editedAt } : m))
      )
    })
  }, [activeConversationId, subscribeToMessageEdited])

  useEffect(() => {
    if (!activeConversationId) return undefined
    return subscribeToMessageDeleted(activeConversationId, (payload) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === payload.id
            ? {
                ...m,
                deletedAt: payload.deletedAt,
                ...CLEARED_ATTACHMENT_FIELDS,
              }
            : m
        )
      )
    })
  }, [activeConversationId, subscribeToMessageDeleted])

  // Both the reactor and the other participant get the same "reaction-added"/
  // "reaction-removed" event (see src/routes/chat.js), so the UI is purely
  // event-driven here rather than also patching state from the POST/DELETE
  // response — one source of truth avoids double-applying the same reaction.
  useEffect(() => {
    if (!activeConversationId) return undefined
    return subscribeToReactionAdded(activeConversationId, (payload) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== payload.messageId) return m
          const reactions = m.reactions ? [...m.reactions] : []
          const idx = reactions.findIndex((r) => r.emoji === payload.emoji)
          if (idx === -1) {
            reactions.push({ emoji: payload.emoji, count: 1, mine: payload.userId === user.id })
          } else {
            reactions[idx] = {
              ...reactions[idx],
              count: reactions[idx].count + 1,
              mine: reactions[idx].mine || payload.userId === user.id,
            }
          }
          return { ...m, reactions }
        })
      )
    })
  }, [activeConversationId, subscribeToReactionAdded, user.id])

  useEffect(() => {
    if (!activeConversationId) return undefined
    return subscribeToReactionRemoved(activeConversationId, (payload) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== payload.messageId || !m.reactions) return m
          const reactions = m.reactions
            .map((r) =>
              r.emoji === payload.emoji
                ? { ...r, count: r.count - 1, mine: payload.userId === user.id ? false : r.mine }
                : r
            )
            .filter((r) => r.count > 0)
          return { ...m, reactions }
        })
      )
    })
  }, [activeConversationId, subscribeToReactionRemoved, user.id])

  // Arrives a beat after the message itself — the server unfurls the link out
  // of band so a slow site can't hold up the send. Also clears the card when
  // an edit removed the URL, since the payload's linkPreview is then null.
  useEffect(() => {
    if (!activeConversationId) return undefined
    return subscribeToLinkPreview(activeConversationId, (payload) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === payload.messageId ? { ...m, linkPreview: payload.linkPreview } : m))
      )
    })
  }, [activeConversationId, subscribeToLinkPreview])

  // Removed outright rather than tombstoned the way message-deleted is: an
  // expired message leaves nothing behind, so neither should its bubble.
  useEffect(() => {
    if (!activeConversationId) return undefined
    return subscribeToMessageExpired(activeConversationId, (payload) => {
      setMessages((prev) => prev.filter((m) => m.id !== payload.id))
    })
  }, [activeConversationId, subscribeToMessageExpired])

  function toggleReaction(message, emoji) {
    const alreadyMine = message.reactions?.find((r) => r.emoji === emoji)?.mine
    const action = alreadyMine ? removeReaction : addReaction
    action(activeConversationId, message.id, emoji, token).catch((err) => setMessagesError(err.message))
  }

  function startEdit(message) {
    setEditingMessageId(message.id)
    setEditingDraft(message.body || '')
  }

  function cancelEdit() {
    setEditingMessageId(null)
    setEditingDraft('')
  }

  async function saveEdit(messageId) {
    const body = editingDraft.trim()
    if (!body) return
    try {
      const updated = await editMessage(activeConversationId, messageId, body, token)
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, ...updated } : m)))
      cancelEdit()
    } catch (err) {
      setMessagesError(err.message)
    }
  }

  async function handleDelete(messageId) {
    if (!window.confirm(t('chat.confirmDeleteMessage'))) return
    try {
      const updated = await deleteMessage(activeConversationId, messageId, token)
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                ...updated,
                ...CLEARED_ATTACHMENT_FIELDS,
              }
            : m
        )
      )
    } catch (err) {
      setMessagesError(err.message)
    }
  }

  function notifyTyping() {
    if (!activeConversationId) return
    const now = Date.now()
    if (now - lastTypingSentAtRef.current < TYPING_SEND_THROTTLE_MS) return
    lastTypingSentAtRef.current = now
    sendTyping(activeConversationId, token).catch(() => {
      // Best-effort presence signal — a failed send just means the other
      // side doesn't see "typing…" this time, nothing to recover from.
    })
  }

  async function loadOlder() {
    if (loadingOlder || messagesLoading) return
    if (!hasMore || nextBefore == null) return

    setLoadingOlder(true)
    const el = messagesElRef.current
    const prevScrollHeight = el?.scrollHeight ?? 0
    try {
      const res = await listMessages(activeConversationId, { before: nextBefore, limit: MESSAGE_PAGE_SIZE }, token)
      setMessages((prev) => [...[...res.data].reverse(), ...prev])
      setHasMore(res.hasMore)
      setNextBefore(res.nextBefore)
      setOlderLoadAnnouncement(t('chat.olderMessagesLoaded', { count: res.data.length }))
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

  async function attemptSend(conversationId, body, tempId, replyToId) {
    try {
      const real = await sendMessage(conversationId, { body, replyToId }, token)
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
    const replyToId = replyingTo?.id ?? null
    // The optimistic bubble reuses replyingTo directly as its quoted
    // snippet — same {id, senderId, body, deletedAt} shape the server
    // returns, so no special-casing is needed once the real message
    // replaces it.
    const replyToSnippet = replyingTo
      ? { id: replyingTo.id, senderId: replyingTo.senderId, body: replyingTo.body, deletedAt: replyingTo.deletedAt }
      : null
    setReplyingTo(null)
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const optimistic = {
      id: tempId,
      conversationId: activeConversationId,
      senderId: user.id,
      body,
      createdAt: new Date().toISOString(),
      pending: true,
      replyTo: replyToSnippet,
    }
    setMessages((prev) => [...prev, optimistic])
    isAtBottomRef.current = true
    requestAnimationFrame(scrollToBottom)
    attemptSend(activeConversationId, body, tempId, replyToId)
  }

  async function handleFileSelected(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file later
    if (!file || !activeConversationId) return

    setUploadError(null)
    setUploadBusy(true)
    try {
      const { url, key } = await requestUpload(
        activeConversationId,
        { fileName: file.name, mimeType: file.type || 'application/octet-stream', size: file.size },
        token
      )
      await uploadFileToR2(url, file)
      const real = await sendMessage(activeConversationId, { attachmentKey: key, attachmentName: file.name }, token)
      setMessages((prev) => [...prev, real])
      isAtBottomRef.current = true
      requestAnimationFrame(scrollToBottom)
    } catch (err) {
      setUploadError(err.message)
    } finally {
      setUploadBusy(false)
    }
  }

  async function handleExport(conversationId) {
    setExportError(null)
    setExportBusy(true)
    try {
      const result = await exportConversation(conversationId, token)
      // The route already sends Content-Disposition: attachment, but that
      // only matters for a plain `<a href>` navigation — a fetch() response
      // (which apiFetch always is) never triggers a browser download on its
      // own, so the file has to be built and "clicked" here instead.
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `conversation-${conversationId}.json`
      link.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setExportError(err.message)
    } finally {
      setExportBusy(false)
    }
  }

  function handleRetry(tempId) {
    const msg = messages.find((m) => m.id === tempId)
    if (!msg) return
    setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, pending: true, failed: false } : m)))
    attemptSend(activeConversationId, msg.body, tempId, msg.replyTo?.id ?? null)
  }

  const threadHeaderName = activeConversation
    ? activeConversation.otherUser.name || activeConversation.otherUser.email
    : t('common.loading')
  useDocumentTitle(activeConversation ? threadHeaderName : t('nav.chat'))

  // Only the caller's most recent (sent, non-failed) message gets a "Read"
  // tick — matching how WhatsApp/Telegram/etc. show it once per thread
  // rather than on every message the other side has read.
  const lastMineMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].senderId === user.id && !messages[i].pending && !messages[i].failed) return messages[i].id
    }
    return null
  }, [messages, user.id])
  const otherLastReadAt = activeConversation?.otherLastReadAt ? new Date(activeConversation.otherLastReadAt) : null

  let lastDayKey = null

  return (
    <div className={activeConversationId ? 'chat-page show-thread' : 'chat-page'}>
      <h1>{t('chat.title')}</h1>

      <div className={`chat-layout${activeConversationId ? ' show-thread' : ''}`}>
        <div className="chat-list-pane">
          <div className="chat-search-wrap">
            <input
              type="search"
              className="search-input"
              placeholder={t('chat.searchPlaceholder')}
              aria-label={t('chat.searchPlaceholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="chat-list-scroll">
            {conversationsError && <p className="error" role="alert">{t('chat.loadError')}</p>}
            {startError && <p className="error" role="alert">{startError}</p>}

            {showFriendsSection && (
              <>
                <div className="chat-list-section-label">{t('chat.sectionFriends')}</div>
                {visibleFriends.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    className="chat-user-result"
                    onClick={() => handleStartChat(u)}
                  >
                    <Avatar user={u} isOnline={u.isOnline} />
                    <span className="chat-conversation-main">
                      <span className="chat-conversation-name">{u.name || u.email}</span>
                      {u.name && <span className="chat-conversation-preview">{u.email}</span>}
                      {u.statusMessage && <span className="user-status-line">{u.statusMessage}</span>}
                    </span>
                  </button>
                ))}
              </>
            )}

            {showConversationsHeading && (
              <div className="chat-list-section-label">{t('chat.sectionConversations')}</div>
            )}

            {conversationsLoading && conversations.length === 0 ? (
              <p className="loading-note">{t('common.loading')}</p>
            ) : filteredConversations.length === 0 ? (
              trimmedQuery ? (
                showNoMatches && <p className="empty-state">{t('chat.noResults')}</p>
              ) : (
                <div className="chat-empty">
                  <strong>{t('chat.noConversationsTitle')}</strong>
                  <span>{t('chat.noConversationsBody')}</span>
                  <Link to="/friends" className="button">
                    {t('chat.addFriendsLink')}
                  </Link>
                </div>
              )
            ) : (
              filteredConversations.map((c, index) => {
                const name = c.otherUser.name || c.otherUser.email
                const unread = c.unreadCount > 0
                // Only shown outside an active search — searching flattens
                // the list to matches, where a "Pinned" divider would just
                // be noise ahead of the thing being searched for.
                const showPinnedLabel = !trimmedQuery && c.pinned && index === 0
                return (
                  <div key={c.id}>
                    {showPinnedLabel && <div className="chat-list-section-label">{t('chat.pinnedSection')}</div>}
                    <div
                      className={`chat-conversation-row${c.id === activeConversationId ? ' active' : ''}${
                        unread ? ' unread' : ''
                      }`}
                    >
                      <Link to={`/chat/${c.id}`} className="chat-conversation-link">
                        <Avatar user={c.otherUser} isOnline={c.otherUser?.isOnline} />
                        <span className="chat-conversation-main">
                          <span className={`chat-conversation-name${unread ? ' unread' : ''}`}>
                            {name}
                            {c.otherUser?.isOnline && <span className="sr-only"> · {t('presence.online')}</span>}
                          </span>
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
                          {c.muted && (
                            <span className="chat-muted-indicator" aria-label={t('chat.mutedIndicator')} title={t('chat.mutedIndicator')}>
                              🔕
                            </span>
                          )}
                        </span>
                      </Link>
                      <button
                        type="button"
                        className={`chat-conversation-pin-btn${c.pinned ? ' pinned' : ''}`}
                        aria-label={c.pinned ? t('chat.unpin') : t('chat.pin')}
                        aria-pressed={c.pinned}
                        onClick={() => setConversationPinned(c.id, !c.pinned)}
                      >
                        📌
                      </button>
                    </div>
                  </div>
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
                <Avatar
                  user={activeConversation?.otherUser || { name: threadHeaderName }}
                  size="sm"
                  isOnline={activeConversation?.otherUser?.isOnline}
                />
                <span className="chat-thread-header-name">
                  {threadHeaderName}
                  {activeConversation?.otherUser?.statusMessage && (
                    <span className="user-status-line">{activeConversation.otherUser.statusMessage}</span>
                  )}
                </span>
                <span className="chat-thread-header-spacer" />
                {activeConversation && (
                  <select
                    className="chat-thread-disappearing"
                    aria-label={t('chat.disappearingMessages')}
                    value={activeConversation.disappearingSeconds ?? ''}
                    onChange={(e) =>
                      changeDisappearing(activeConversation.id, e.target.value ? Number(e.target.value) : null)
                    }
                  >
                    <option value="">{t('chat.disappearingOff')}</option>
                    {DISAPPEARING_OPTIONS.map((seconds) => (
                      <option key={seconds} value={seconds}>
                        {t(`chat.disappearing${seconds}`)}
                      </option>
                    ))}
                  </select>
                )}
                {activeConversation && (
                  <button
                    type="button"
                    className="chat-thread-mute-btn"
                    aria-label={t(activeConversation.muted ? 'chat.unmute' : 'chat.mute')}
                    aria-pressed={activeConversation.muted}
                    onClick={() => setConversationMuted(activeConversation.id, !activeConversation.muted)}
                  >
                    {activeConversation.muted ? '🔕' : '🔔'}
                  </button>
                )}
                <button
                  type="button"
                  className="chat-thread-search-btn"
                  aria-label={t('chat.exportConversation')}
                  disabled={exportBusy}
                  onClick={() => handleExport(activeConversationId)}
                >
                  {exportBusy ? '⏳' : '⬇️'}
                </button>
                <button
                  type="button"
                  className="chat-thread-search-btn"
                  aria-label={t('chat.searchInConversation')}
                  aria-pressed={searchOpen}
                  onClick={() => setSearchOpen((open) => !open)}
                >
                  🔍
                </button>
              </div>

              {searchOpen && (
                <div className="chat-search-bar">
                  <input
                    type="search"
                    className="search-input"
                    autoFocus
                    placeholder={t('chat.searchInConversationPlaceholder')}
                    aria-label={t('chat.searchInConversationPlaceholder')}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
              )}

              {(connectionState === 'reconnecting' || connectionState === 'down') && (
                <div
                  className={`chat-stream-banner${connectionState === 'down' ? ' down' : ''}`}
                  role="status"
                  aria-live={connectionState === 'down' ? 'assertive' : 'polite'}
                >
                  <span>{connectionState === 'down' ? t('chat.disconnected') : t('chat.reconnecting')}</span>
                  {connectionState === 'down' && (
                    <button type="button" onClick={() => window.location.reload()}>
                      {t('chat.reconnectNow')}
                    </button>
                  )}
                </div>
              )}

              <div role="status" aria-live="polite" className="sr-only">
                {olderLoadAnnouncement}
              </div>
              <div className="chat-messages" ref={messagesElRef} onScroll={handleScroll}>
                {searchOpen && searchQuery.trim() ? (
                  <div>
                    {searchError && <p className="error" role="alert">{searchError}</p>}
                    {searchLoading ? (
                      <p className="loading-note">{t('common.loading')}</p>
                    ) : searchResults && searchResults.length === 0 ? (
                      <p className="empty-state">{t('chat.noResults')}</p>
                    ) : (
                      searchResults?.map((m) => (
                        <div key={m.id} className="chat-search-result-row">
                          <span className="chat-search-result-meta">
                            {(m.senderId === user.id ? t('chat.you') : threadHeaderName) +
                              ' · ' +
                              formatListTimestamp(m.createdAt, language)}
                          </span>
                          <span className="chat-search-result-body">{m.body}</span>
                        </div>
                      ))
                    )}
                  </div>
                ) : (
                  <>
                {messagesError && <p className="error" role="alert">{messagesError}</p>}
                {hasMore && (
                  <button type="button" className="chat-load-more" onClick={loadOlder} disabled={loadingOlder}>
                    {loadingOlder ? t('common.loading') : t('chat.loadOlder')}
                  </button>
                )}
                {messagesLoading ? (
                  <p className="loading-note">{t('chat.loadingMessages')}</p>
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
                          <div className="chat-bubble-wrap">
                            {m.deletedAt ? (
                              <div className="chat-bubble deleted">
                                <span>{t('chat.messageDeleted')}</span>
                              </div>
                            ) : editingMessageId === m.id ? (
                              <div className="chat-bubble-edit">
                                <input
                                  type="text"
                                  value={editingDraft}
                                  onChange={(e) => setEditingDraft(e.target.value)}
                                  maxLength={4000}
                                  autoFocus
                                  aria-label={t('chat.editMessage')}
                                />
                                <div className="chat-bubble-edit-actions">
                                  <button type="button" onClick={() => saveEdit(m.id)} disabled={!editingDraft.trim()}>
                                    {t('chat.save')}
                                  </button>
                                  <button type="button" onClick={cancelEdit}>
                                    {t('chat.cancel')}
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="chat-bubble">
                                {m.replyTo && (
                                  <div className="chat-bubble-quote">
                                    <span className="chat-bubble-quote-name">
                                      {m.replyTo.senderId === user.id ? t('chat.you') : threadHeaderName}
                                    </span>
                                    <span className="chat-bubble-quote-body">
                                      {m.replyTo.deletedAt ? t('chat.messageDeleted') : m.replyTo.body}
                                    </span>
                                  </div>
                                )}
                                {m.attachmentType === 'image' && (
                                  <a href={m.attachmentUrl} target="_blank" rel="noreferrer" className="chat-attachment-image-link">
                                    <img src={m.attachmentUrl} alt={m.attachmentName || ''} className="chat-attachment-image" />
                                  </a>
                                )}
                                {m.attachmentType === 'file' && (
                                  <a
                                    href={m.attachmentUrl}
                                    download={m.attachmentName}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="chat-attachment-file"
                                  >
                                    <span className="chat-attachment-file-icon">📄</span>
                                    <span className="chat-attachment-file-info">
                                      <span className="chat-attachment-file-name">{m.attachmentName}</span>
                                      <span className="chat-attachment-file-size">
                                        {m.attachmentSize ? `${Math.round(m.attachmentSize / 1024)} KB` : ''}
                                      </span>
                                    </span>
                                  </a>
                                )}
                                {linkifyText(m.body)}
                                {m.editedAt && <span className="chat-bubble-edited-tag"> {t('chat.edited')}</span>}
                                {m.linkPreview && (
                                  <LinkPreviewCard
                                    preview={m.linkPreview}
                                    conversationId={activeConversationId}
                                    messageId={m.id}
                                  />
                                )}
                                <span className="chat-bubble-time">
                                  {formatTime(m.createdAt, language)}
                                  {mine && m.id === lastMineMessageId && (() => {
                                    const isRead = otherLastReadAt && otherLastReadAt >= new Date(m.createdAt)
                                    if (isRead) return <span className="chat-bubble-read-tag"> · {t('chat.read')}</span>
                                    // Only known for a message sent this session (see the
                                    // src/routes/chat.js comment on `delivered` — it isn't
                                    // persisted, so a page reload loses it and the tag just
                                    // stops showing rather than showing something false).
                                    if (m.delivered) return <span className="chat-bubble-read-tag"> · {t('chat.delivered')}</span>
                                    return null
                                  })()}
                                </span>
                              </div>
                            )}
                            {!m.deletedAt && m.reactions?.length > 0 && (
                              <div className={`chat-bubble-reactions ${mine ? 'mine' : 'theirs'}`}>
                                {m.reactions.map((r) => (
                                  <button
                                    key={r.emoji}
                                    type="button"
                                    className={`chat-reaction-pill${r.mine ? ' mine' : ''}`}
                                    aria-pressed={r.mine}
                                    aria-label={t('chat.reactionPillLabel', { emoji: r.emoji, count: r.count })}
                                    onClick={() => toggleReaction(m, r.emoji)}
                                  >
                                    <span aria-hidden="true">{r.emoji}</span> {r.count}
                                  </button>
                                ))}
                              </div>
                            )}
                            {!m.pending && !m.failed && !m.deletedAt && editingMessageId !== m.id && (
                              <div className="chat-bubble-actions">
                                <span className="chat-bubble-reaction-trigger-wrap">
                                  <button
                                    type="button"
                                    className="chat-bubble-action-btn"
                                    aria-label={t('chat.addReaction')}
                                    aria-expanded={reactionPickerMessageId === m.id}
                                    onClick={() =>
                                      setReactionPickerMessageId((id) => (id === m.id ? null : m.id))
                                    }
                                  >
                                    😊
                                  </button>
                                  {reactionPickerMessageId === m.id && (
                                    <EmojiPicker
                                      onSelect={(emoji) => {
                                        setReactionPickerMessageId(null)
                                        toggleReaction(m, emoji)
                                      }}
                                      onClose={() => setReactionPickerMessageId(null)}
                                    />
                                  )}
                                </span>
                                <button
                                  type="button"
                                  className="chat-bubble-action-btn"
                                  aria-label={t('chat.reply')}
                                  onClick={() => setReplyingTo(m)}
                                >
                                  ↩️
                                </button>
                                {mine && (
                                  <>
                                    <button
                                      type="button"
                                      className="chat-bubble-action-btn"
                                      aria-label={t('chat.editMessage')}
                                      onClick={() => startEdit(m)}
                                    >
                                      ✏️
                                    </button>
                                    <button
                                      type="button"
                                      className="chat-bubble-action-btn"
                                      aria-label={t('chat.deleteMessage')}
                                      onClick={() => handleDelete(m.id)}
                                    >
                                      🗑️
                                    </button>
                                  </>
                                )}
                              </div>
                            )}
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
                  </>
                )}
              </div>

              <div className="chat-typing-indicator" aria-live="polite">
                {otherTyping && t('chat.typingIndicator', { name: threadHeaderName })}
              </div>

              {replyingTo && (
                <div className="chat-reply-banner">
                  <span className="chat-reply-banner-text">
                    <span className="chat-reply-banner-name">
                      {t('chat.replyingTo', { name: replyingTo.senderId === user.id ? t('chat.you') : threadHeaderName })}
                    </span>
                    <span className="chat-reply-banner-body">
                      {replyingTo.deletedAt ? t('chat.messageDeleted') : replyingTo.body}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="chat-thread-search-btn"
                    aria-label={t('chat.cancelReply')}
                    onClick={() => setReplyingTo(null)}
                  >
                    ✕
                  </button>
                </div>
              )}

              {exportError && <p className="error" role="alert">{exportError}</p>}
              {uploadError && <p className="error" role="alert">{uploadError}</p>}
              <form className="chat-composer" onSubmit={handleSend}>
                <div className="chat-composer-emoji-wrap">
                  <button
                    type="button"
                    className="chat-composer-emoji-btn"
                    aria-label={t('chat.emojiPicker')}
                    aria-expanded={emojiPickerOpen}
                    onClick={() => setEmojiPickerOpen((open) => !open)}
                  >
                    😊
                  </button>
                  {emojiPickerOpen && (
                    <EmojiPicker
                      onSelect={(emoji) => setDraft((prev) => prev + emoji)}
                      onClose={() => setEmojiPickerOpen(false)}
                    />
                  )}
                </div>
                <input
                  type="file"
                  ref={fileInputRef}
                  className="chat-composer-file-input"
                  onChange={handleFileSelected}
                  disabled={uploadBusy}
                />
                <button
                  type="button"
                  className="chat-composer-attach-btn"
                  aria-label={uploadBusy ? t('common.loading') : t('chat.attachFile')}
                  disabled={uploadBusy}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <span aria-hidden="true">{uploadBusy ? '…' : '📎'}</span>
                </button>
                <input
                  type="text"
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value)
                    notifyTyping()
                  }}
                  placeholder={t('chat.composerPlaceholder')}
                  aria-label={t('chat.composerPlaceholder')}
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
