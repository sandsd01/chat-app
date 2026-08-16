import { useLanguage } from '../context/LanguageContext'

// A quiet echo of TicketId's ink-stamp language (see index.css's
// design-tokens comment) — NOT a second bold moment, just enough identity
// that every auth page and the logged-in navbar read as the same product.
// Self-contained (reads its own translation) since it's identical
// everywhere it appears, unlike page-specific content. `compact` is for the
// navbar (Layout.jsx), which previously had no branding at all — logged-in
// users never saw the product's identity, only the 6 unauthenticated pages
// did.
export function AuthBrand({ compact = false }) {
  const { t } = useLanguage()
  return (
    <div className={`auth-brand${compact ? ' compact' : ''}`}>
      <span className="auth-brand-mark" aria-hidden="true">
        {/* The claim-ticket mark, identical in shape to public/favicon.svg and
            the PWA icons. currentColor rather than a literal, so it inherits
            --accent-contrast from .auth-brand-mark and stays legible when
            dark mode flips that value. One evenodd path: the tear-off line is
            a hole, not a second fill. */}
        <svg viewBox="0 0 64 64" width="100%" height="100%" focusable="false">
          <path
            fill="currentColor"
            fillRule="evenodd"
            d="M9 20 L55 20 A3 3 0 0 1 58 23 L58 28 A4 4 0 0 0 58 36 L58 41 A3 3 0 0 1 55 44 L9 44 A3 3 0 0 1 6 41 L6 36 A4 4 0 0 0 6 28 L6 23 A3 3 0 0 1 9 20 Z M45 24 L47 24 L47 40 L45 40 Z"
          />
        </svg>
      </span>
      {t('common.appName')}
    </div>
  )
}
