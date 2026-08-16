import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { apiFetch } from '../api/client'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { AuthBrand } from '../components/AuthBrand'
import { useDocumentTitle } from '../hooks/useDocumentTitle'

// 'pending' | 'success' | 'error'
export function VerifyEmailPage() {
  const { t } = useLanguage()
  useDocumentTitle(t('verifyEmail.title'))
  const { user, updateUser } = useAuth()
  const [searchParams] = useSearchParams()
  const email = searchParams.get('email')
  const token = searchParams.get('token')

  const [status, setStatus] = useState(email && token ? 'pending' : 'error')
  const [error, setError] = useState(null)
  // The email link can be opened once (StrictMode double-invokes effects in
  // dev, and the token is single-use server-side) — guard against firing the
  // request twice and turning a real success into a spurious "invalid link".
  const requestedRef = useRef(false)

  useEffect(() => {
    if (!email || !token || requestedRef.current) return
    requestedRef.current = true
    apiFetch('/auth/verify-email', { method: 'POST', body: { email, token } })
      .then((data) => {
        setStatus('success')
        // If this tab happens to already be logged in as the account that
        // just got verified, patch its cached session directly — otherwise
        // there's no session here to update at all, which is fine.
        if (user?.email === email) updateUser({ emailVerifiedAt: data.emailVerifiedAt })
      })
      .catch((err) => {
        setError(err.message)
        setStatus('error')
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, token])

  return (
    <div className="centered">
      <AuthBrand />
      <div className="card">
        <h1>{t('verifyEmail.title')}</h1>
        {status === 'pending' && <p className="hint" role="status">{t('common.loading')}</p>}
        {status === 'success' && <p className="notice">{t('verifyEmail.success')}</p>}
        {status === 'error' && <p className="error" role="alert">{error || t('verifyEmail.invalidLink')}</p>}
        <Link to={user ? '/chat' : '/login'}>
          {user ? t('verifyEmail.continueToApp') : t('login.backToLogin')}
        </Link>
      </div>
    </div>
  )
}
