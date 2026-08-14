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
      <span className="auth-brand-mark" aria-hidden="true">C</span>
      {t('common.appName')}
    </div>
  )
}
