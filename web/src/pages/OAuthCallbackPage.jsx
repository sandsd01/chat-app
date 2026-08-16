import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { AuthBrand } from '../components/AuthBrand'
import { useDocumentTitle } from '../hooks/useDocumentTitle'

export function OAuthCallbackPage() {
  const [searchParams] = useSearchParams()
  const ticket = searchParams.get('ticket')
  const { loginWithGoogleTicket } = useAuth()
  const { t } = useLanguage()
  const navigate = useNavigate()
  const [error, setError] = useState(null)
  useDocumentTitle()

  useEffect(() => {
    if (!ticket) {
      setError(t('login.oauthMissingTicket'))
      return
    }
    let cancelled = false
    loginWithGoogleTicket(ticket)
      .then(() => {
        if (!cancelled) navigate('/', { replace: true })
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
    // Runs once on mount with whatever ticket the URL arrived with — the
    // ticket is single-use, so re-running this on a dependency change would
    // just fail the second time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="centered">
      <AuthBrand />
      <div className="card">
        {error ? (
          <>
            <p className="error" role="alert">{error}</p>
            <Link to="/login">{t('login.backToLogin')}</Link>
          </>
        ) : (
          <p>{t('common.loading')}</p>
        )}
      </div>
    </div>
  )
}
