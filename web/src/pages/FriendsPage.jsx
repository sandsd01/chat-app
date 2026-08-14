import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { useChat } from '../context/ChatContext'
import { useFriends } from '../context/FriendsContext'
import { lookupByPublicId } from '../api/friends'
import { TicketId } from '../components/TicketId'
import { initials } from '../lib/format'

export function FriendsPage() {
  const { token, user } = useAuth()
  const { t } = useLanguage()
  const { startChat } = useChat()
  const {
    friends,
    incoming,
    outgoing,
    loading,
    error,
    sendRequest,
    acceptRequest,
    declineRequest,
    cancelRequest,
    removeFriend,
    blockUser,
  } = useFriends()
  const navigate = useNavigate()

  const [lookupId, setLookupId] = useState('')
  const [lookupResult, setLookupResult] = useState(null)
  const [lookupError, setLookupError] = useState(null)
  const [lookupLoading, setLookupLoading] = useState(false)
  const [actionError, setActionError] = useState(null)
  // Keyed by "action:id" (e.g. "accept:42"), not just id, so two different
  // actions on the same row (Remove vs Block) don't both light up as busy
  // when only one of them was actually clicked.
  const [busyKey, setBusyKey] = useState(null)

  async function handleLookup(e) {
    e.preventDefault()
    const id = lookupId.trim()
    if (!id) return
    setLookupError(null)
    setLookupResult(null)
    setLookupLoading(true)
    try {
      const result = await lookupByPublicId(id, token)
      setLookupResult(result)
    } catch (err) {
      setLookupError(err.message)
    } finally {
      setLookupLoading(false)
    }
  }

  async function handleSendFromLookup() {
    if (!lookupResult) return
    setActionError(null)
    try {
      const result = await sendRequest(lookupResult.publicId)
      setLookupResult({
        ...lookupResult,
        relationship: result.status === 'accepted' ? 'friends' : 'requestSent',
      })
    } catch (err) {
      setActionError(err.message)
    }
  }

  async function runAction(key, fn) {
    setActionError(null)
    setBusyKey(key)
    try {
      return await fn()
    } catch (err) {
      setActionError(err.message)
      return undefined
    } finally {
      setBusyKey(null)
    }
  }

  async function handleMessage(key, friendUser) {
    const summary = await runAction(key, () => startChat(friendUser.id))
    if (summary) navigate(`/chat/${summary.id}`)
  }

  return (
    <div>
      <h1>{t('friends.title')}</h1>

      <div className="card card-wide friends-own-id">
        <span className="friends-caption">{t('friends.yourId')}</span>
        <TicketId id={user.publicId} copyLabel={t('friends.copy')} copiedLabel={t('friends.copied')} />
        <p className="friends-caption">{t('friends.shareHint')}</p>
      </div>

      <div className="card card-wide">
        <h2>{t('friends.addTitle')}</h2>
        <form className="inline-form friends-lookup-form" onSubmit={handleLookup}>
          <input
            type="text"
            className="search-input"
            placeholder={t('friends.addPlaceholder')}
            aria-label={t('friends.addPlaceholder')}
            value={lookupId}
            onChange={(e) => setLookupId(e.target.value)}
          />
          <button type="submit" disabled={lookupLoading || !lookupId.trim()}>
            {lookupLoading ? t('common.loading') : t('friends.find')}
          </button>
        </form>
        {lookupError && <p className="error" role="alert">{lookupError}</p>}
        {actionError && <p className="error" role="alert">{actionError}</p>}
        {lookupResult && (
          <div className="friend-row" role="status" aria-live="polite">
            <span className="chat-avatar">{initials(lookupResult.name || lookupResult.email)}</span>
            <span className="chat-conversation-main">
              <span className="chat-conversation-name">{lookupResult.name || lookupResult.email}</span>
              <span className="chat-conversation-preview">{lookupResult.publicId}</span>
            </span>
            {lookupResult.relationship === 'none' && (
              <button type="button" onClick={handleSendFromLookup}>
                {t('friends.sendRequest')}
              </button>
            )}
            {lookupResult.relationship === 'requestSent' && (
              <span className="friends-caption">{t('friends.requestPending')}</span>
            )}
            {lookupResult.relationship === 'requestReceived' && (
              <span className="friends-caption">{t('friends.theySentYouOne')}</span>
            )}
            {lookupResult.relationship === 'friends' && <span className="friends-caption">{t('friends.alreadyFriends')}</span>}
            {lookupResult.relationship === 'blocked' && <span className="friends-caption">{t('friends.cantAdd')}</span>}
          </div>
        )}
      </div>

      {(incoming.length > 0 || outgoing.length > 0) && (
        <div className="card card-wide">
          <h2>{t('friends.requestsTitle')}</h2>
          {incoming.length > 0 && (
            <>
              <div className="chat-list-section-label">{t('friends.incoming')}</div>
              {incoming.map((r) => (
                <div className="friend-row" key={r.requestId}>
                  <span className="chat-avatar">{initials(r.otherUser.name || r.otherUser.email)}</span>
                  <span className="chat-conversation-main">
                    <span className="chat-conversation-name">{r.otherUser.name || r.otherUser.email}</span>
                  </span>
                  <button
                    type="button"
                    disabled={busyKey === `accept:${r.requestId}`}
                    onClick={() => runAction(`accept:${r.requestId}`, () => acceptRequest(r.requestId))}
                  >
                    {busyKey === `accept:${r.requestId}` ? t('common.loading') : t('friends.accept')}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busyKey === `decline:${r.requestId}`}
                    onClick={() => runAction(`decline:${r.requestId}`, () => declineRequest(r.requestId))}
                  >
                    {busyKey === `decline:${r.requestId}` ? t('common.loading') : t('friends.decline')}
                  </button>
                </div>
              ))}
            </>
          )}
          {outgoing.length > 0 && (
            <>
              <div className="chat-list-section-label">{t('friends.outgoing')}</div>
              {outgoing.map((r) => (
                <div className="friend-row" key={r.requestId}>
                  <span className="chat-avatar">{initials(r.otherUser.name || r.otherUser.email)}</span>
                  <span className="chat-conversation-main">
                    <span className="chat-conversation-name">{r.otherUser.name || r.otherUser.email}</span>
                  </span>
                  <span className="friends-caption">{t('friends.requestPending')}</span>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busyKey === `cancel:${r.requestId}`}
                    onClick={() => runAction(`cancel:${r.requestId}`, () => cancelRequest(r.requestId))}
                  >
                    {busyKey === `cancel:${r.requestId}` ? t('common.loading') : t('friends.cancel')}
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      <div className="card card-wide">
        <h2>{t('friends.listTitle')}</h2>
        {error && <p className="error" role="alert">{t('friends.loadError')}</p>}
        {loading && friends.length === 0 ? (
          <p className="hint">{t('common.loading')}</p>
        ) : friends.length === 0 ? (
          <p className="hint">{t('friends.noFriends')}</p>
        ) : (
          friends.map((f) => (
            <div className="friend-row" key={f.friendshipId}>
              <span className="chat-avatar">{initials(f.otherUser.name || f.otherUser.email)}</span>
              <span className="chat-conversation-main">
                <span className="chat-conversation-name">{f.otherUser.name || f.otherUser.email}</span>
              </span>
              <button
                type="button"
                disabled={busyKey === `message:${f.friendshipId}`}
                onClick={() => handleMessage(`message:${f.friendshipId}`, f.otherUser)}
              >
                {busyKey === `message:${f.friendshipId}` ? t('common.loading') : t('friends.message')}
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={busyKey === `remove:${f.friendshipId}`}
                onClick={() => {
                  const name = f.otherUser.name || f.otherUser.email
                  if (window.confirm(t('friends.confirmRemove', { name }))) {
                    runAction(`remove:${f.friendshipId}`, () => removeFriend(f.otherUser.id))
                  }
                }}
              >
                {busyKey === `remove:${f.friendshipId}` ? t('common.loading') : t('friends.remove')}
              </button>
              <button
                type="button"
                className="btn-secondary-danger"
                disabled={busyKey === `block:${f.friendshipId}`}
                onClick={() => {
                  const name = f.otherUser.name || f.otherUser.email
                  if (window.confirm(t('friends.confirmBlock', { name }))) {
                    runAction(`block:${f.friendshipId}`, () => blockUser(f.otherUser.id))
                  }
                }}
              >
                {busyKey === `block:${f.friendshipId}` ? t('common.loading') : t('friends.block')}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
