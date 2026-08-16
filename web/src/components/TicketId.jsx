import { useState } from 'react'

// The one bold, deliberately singular visual moment in the app (see the
// design-tokens comment at the top of index.css) — a public ID rendered as
// a small perforated claim-check stub, since that's literally what a
// publicId is: a private code handed to exactly one other person, never
// published anywhere. Used in exactly two places (AccountPage, FriendsPage's
// own-ID card) and nowhere else — not for anyone else's ID, not for any
// other kind of code — so it stays a signature rather than a pattern.
export function TicketId({ id, copyLabel, copiedLabel, copyable = true }) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    navigator.clipboard?.writeText(id).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="ticket-id">
      <div className="ticket-id-stub">
        <span className="ticket-id-mark" aria-hidden="true" />
        <span className="ticket-id-code">{id}</span>
      </div>
      {copyable && (
        <button
          type="button"
          className="btn-secondary"
          onClick={handleCopy}
          aria-live="polite"
          aria-atomic="true"
        >
          {copied ? copiedLabel : copyLabel}
        </button>
      )}
    </div>
  )
}
