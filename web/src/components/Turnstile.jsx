import { useEffect, useRef } from 'react'
import { renderTurnstile, removeTurnstile } from '../lib/turnstile'

// Only rendered by the caller once GET /auth/captcha-config reports
// configured: true — see SignupPage.jsx. `onToken('')` on expiry/error
// mirrors Turnstile's own contract (a stale/failed widget stops carrying a
// valid token) so the caller's submit button can disable itself again.
export function Turnstile({ siteKey, onToken }) {
  const containerRef = useRef(null)
  const widgetIdRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    renderTurnstile(containerRef.current, siteKey, {
      onToken,
      onExpire: () => onToken(''),
      onError: () => onToken(''),
    }).then((id) => {
      // The widget finished loading after this effect's own cleanup already
      // ran (e.g. a fast unmount) — tear it down instead of leaking it.
      if (cancelled) removeTurnstile(id)
      else widgetIdRef.current = id
    })
    return () => {
      cancelled = true
      if (widgetIdRef.current != null) removeTurnstile(widgetIdRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey])

  return <div ref={containerRef} className="turnstile-widget" />
}
