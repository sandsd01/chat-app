import { useState } from 'react'
import { initials } from '../lib/format'

/**
 * One user's avatar: their uploaded image when there is one, otherwise the
 * initials badge this app has always drawn. Every call site renders through
 * here so the image/initials fallback and the presence dot stay identical
 * across the friends list, conversation list, and thread header.
 *
 * `isOnline` is a point-in-time value from the API (see GET /friends), not a
 * live subscription — pass undefined to render no dot at all, which is what
 * every context that doesn't fetch presence should do rather than showing a
 * misleading "offline" dot.
 */
export function Avatar({ user, size, isOnline }) {
  // An avatarUrl is a short-lived presigned URL; if it has expired by the
  // time the browser loads it, fall back to initials rather than showing a
  // broken image icon.
  const [failed, setFailed] = useState(false)

  const name = user?.name || user?.email || ''
  const url = failed ? null : user?.avatarUrl
  const className = `chat-avatar${size === 'sm' ? ' sm' : ''}${size === 'lg' ? ' lg' : ''}`

  const badge = url ? (
    <img className={className} src={url} alt="" onError={() => setFailed(true)} />
  ) : (
    <span className={className} aria-hidden="true">
      {initials(name)}
    </span>
  )

  if (isOnline === undefined) return badge

  return (
    <span className="avatar-wrap">
      {badge}
      <span className={`presence-dot${isOnline ? ' online' : ''}`} aria-hidden="true" />
    </span>
  )
}
