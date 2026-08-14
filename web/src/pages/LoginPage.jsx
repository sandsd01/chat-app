import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { AuthBrand } from '../components/AuthBrand'

const OAUTH_ERROR_KEYS = {
  invalid_state: 'login.oauthErrorState',
  google_exchange_failed: 'login.oauthErrorExchange',
  email_not_verified: 'login.oauthErrorUnverified',
  google_not_configured: 'login.oauthErrorUnconfigured',
}

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const { login } = useAuth()
  const { language, setLanguage, t } = useLanguage()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const oauthErrorCode = searchParams.get('error')
  const oauthError = oauthErrorCode
    ? t(OAUTH_ERROR_KEYS[oauthErrorCode] || 'login.oauthErrorGeneric')
    : null

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await login(email, password)
      navigate('/')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="centered">
      <AuthBrand />
      <form className="card" onSubmit={handleSubmit}>
        <div className="page-header">
          <h1>{t('login.title')}</h1>
          <select
            className="language-select"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            aria-label="Language"
          >
            <option value="en">EN</option>
            <option value="th">ไทย</option>
          </select>
        </div>
        {oauthError && <p className="error">{oauthError}</p>}
        {error && <p className="error">{error}</p>}
        <label>
          {t('login.email')}
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label>
          {t('login.password')}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={loading}>
          {loading ? t('login.submitting') : t('login.submit')}
        </button>
        <div className="divider">
          <span>{t('common.or')}</span>
        </div>
        <a href="/api/auth/google" className="btn-secondary button">
          {t('login.continueWithGoogle')}
        </a>
        <Link to="/forgot-password">{t('login.forgotPassword')}</Link>
        <Link to="/signup">{t('login.needAccount')}</Link>
      </form>
    </div>
  )
}
