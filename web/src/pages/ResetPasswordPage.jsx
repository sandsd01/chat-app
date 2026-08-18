import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { apiFetch } from '../api/client'
import { useLanguage } from '../context/LanguageContext'
import { AuthBrand } from '../components/AuthBrand'
import { useDocumentTitle } from '../hooks/useDocumentTitle'

export function ResetPasswordPage() {
  const { t } = useLanguage()
  useDocumentTitle(t('resetPassword.title'))
  const [searchParams] = useSearchParams()
  const email = searchParams.get('email')
  const token = searchParams.get('token')

  const [newPassword, setNewPassword] = useState('')
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setMessage(null)
    setLoading(true)
    try {
      await apiFetch('/auth/reset-password', {
        method: 'POST',
        body: { email, token, newPassword },
      })
      setMessage(t('resetPassword.success'))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  if (!email || !token) {
    return (
      <div className="centered">
        <AuthBrand />
        <div className="card">
          <h1>{t('resetPassword.title')}</h1>
          <p className="error" role="alert">{t('resetPassword.invalidLink')}</p>
          <Link to="/forgot-password">{t('login.forgotPassword')}</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="centered">
      <AuthBrand />
      <form className="card" onSubmit={handleSubmit}>
        <h1>{t('resetPassword.title')}</h1>
        {error && <p className="error" role="alert">{error}</p>}
        {message ? (
          <>
            <p className="notice">{message}</p>
            <Link to="/login">{t('login.backToLogin')}</Link>
          </>
        ) : (
          <>
            <label>
              {t('resetPassword.newPassword')}
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                minLength={8}
                required
              />
            </label>
            <p className="friends-caption">{t('common.passwordHint')}</p>
            <button type="submit" disabled={loading}>
              {loading ? t('common.loading') : t('resetPassword.submit')}
            </button>
          </>
        )}
      </form>
    </div>
  )
}
