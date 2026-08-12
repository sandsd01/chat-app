import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { useChat } from '../context/ChatContext'
import { useFriends } from '../context/FriendsContext'
import { lookupByPublicId } from '../api/friends'

function initials(nameOrEmail) {
  const source = (nameOrEmail || '').trim()
  if (!source) return '?'
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return source.slice(0, 2).toUpperCase()
}

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

  const [copied, setCopied] = useState(false)
  const [lookupId, setLookupId] = useState('')
  const [lookupResult, setLookupResult] = useState(null)
  const [lookupError, setLookupError] = useState(null)
  const [lookupLoading, setLookupLoading] = useState(false)
  const [actionError, setActionError] = useState(null)
  const [busyId, setBusyId] = useState(null)

  function copyOwnId() {
    navigator.clipboard?.writeText(user.publicId).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

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

  async function runAction(id, fn) {
    setActionError(null)
    setBusyId(id)
    try {
      await fn()
    } catch (err) {
      setActionError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  async function handleMessage(friendUser) {
    try {
      const summary = await startChat(friendUser.id)
      navigate(`/chat/${summary.id}`)
    } catch (err) {
      setActionError(err.message)
    }
  }

  return (
    <div>
      <h1>{t('friends.title')}</h1>

      <div className="card card-wide friends-own-id">
        <span className="friends-caption">{t('friends.yourId')}</span>
        <div className="friends-own-id-row">
          <code className="friends-id-code">{user.publicId}</code>
          <button type="button" className="btn-secondary" onClick={copyOwnId}>
            {copied ? t('friends.copied') : t('friends.copy')}
          </button>
        </div>
        <p className="friends-caption">{t('friends.shareHint')}</p>
      </div>

      <div className="card card-wide">
        <h2>{t('friends.addTitle')}</h2>
        <form className="inline-form friends-lookup-form" onSubmit={handleLookup}>
          <input
            type="text"
            className="search-input"
            placeholder={t('friends.addPlaceholder')}
            value={lookupId}
            onChange={(e) => setLookupId(e.target.value)}
          />
          <button type="submit" disabled={lookupLoading || !lookupId.trim()}>
            {lookupLoading ? t('common.loading') : t('friends.find')}
          </button>
        </form>
        {lookupError && <p className="error">{lookupError}</p>}
        {actionError && <p className="error">{actionError}</p>}
        {lookupResult && (
          <div className="friend-row">
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
                    disabled={busyId === r.requestId}
                    onClick={() => runAction(r.requestId, () => acceptRequest(r.requestId))}
                  >
                    {t('friends.accept')}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busyId === r.requestId}
                    onClick={() => runAction(r.requestId, () => declineRequest(r.requestId))}
                  >
                    {t('friends.decline')}
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
                    disabled={busyId === r.requestId}
                    onClick={() => runAction(r.requestId, () => cancelRequest(r.requestId))}
                  >
                    {t('friends.cancel')}
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      <div className="card card-wide">
        <h2>{t('friends.listTitle')}</h2>
        {error && <p className="error">{t('friends.loadError')}</p>}
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
              <button type="button" onClick={() => handleMessage(f.otherUser)}>
                {t('friends.message')}
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={busyId === f.friendshipId}
                onClick={() => runAction(f.friendshipId, () => removeFriend(f.otherUser.id))}
              >
                {t('friends.remove')}
              </button>
              <button
                type="button"
                className="btn-secondary-danger"
                disabled={busyId === f.friendshipId}
                onClick={() => runAction(f.friendshipId, () => blockUser(f.otherUser.id))}
              >
                {t('friends.block')}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
