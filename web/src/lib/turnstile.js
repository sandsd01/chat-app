// Loads Cloudflare Turnstile's own script and drives its vanilla JS widget
// API directly, rather than adding an npm wrapper package for what's a
// handful of calls — same reasoning as src/lib/drive.js talking to the
// Drive REST API straight over fetch instead of pulling in `googleapis`.
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js'

let loadPromise = null

function loadScript() {
  if (window.turnstile) return Promise.resolve()
  if (loadPromise) return loadPromise
  loadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT_SRC
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load the CAPTCHA widget'))
    document.head.appendChild(script)
  })
  return loadPromise
}

export async function renderTurnstile(container, siteKey, { onToken, onExpire, onError } = {}) {
  await loadScript()
  return window.turnstile.render(container, {
    sitekey: siteKey,
    callback: onToken,
    'expired-callback': onExpire,
    'error-callback': onError,
  })
}

export function removeTurnstile(widgetId) {
  if (window.turnstile && widgetId != null) window.turnstile.remove(widgetId)
}
