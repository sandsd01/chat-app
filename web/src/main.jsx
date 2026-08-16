import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted (not a Google Fonts <link>) so there's no third-party request
// on every page load — matches this app's existing privacy posture (no
// public user directory, no third-party analytics). Only the specific
// weights actually used are imported, not
// each package's full index.css (which pulls every weight/style combo).
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/source-serif-4/400.css'
import './index.css'
import App from './App.jsx'

// Registered unconditionally at startup (not gated behind login) — this is
// what makes the app installable at all; actually subscribing to push still
// requires an explicit, logged-in user gesture (see AccountPage).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.error('Service worker registration failed:', err)
    })
  })
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
