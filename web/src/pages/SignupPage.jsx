import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { apiFetch } from '../api/client'
import { Turnstile } from '../components/Turnstile'
import { AuthBrand } from '../components/AuthBrand'

export function SignupPage() {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const { signup } = useAuth()
  const { t } = useLanguage()
  const navigate = useNavigate()

  // Unauthenticated on purpose — the signup page has no session yet. Stays
  // null (rather than defaulting to "not configured") while the request is
  // in flight so the widget doesn't flash in only after a slow response.
  const [captchaConfig, setCaptchaConfig] = useState(null)
  const [captchaToken, setCaptchaToken] = useState('')

  useEffect(() => {
    apiFetch('/auth/captcha-config')
      .then(setCaptchaConfig)
      .catch(() => setCaptchaConfig({ configured: false, siteKey: null }))
  }, [])

  const captchaRequired = captchaConfig?.configured
  const captchaSatisfied = !captchaRequired || Boolean(captchaToken)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await signup(email, password, name, captchaToken || undefined)
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
        <h1>{t('signup.title')}</h1>
        {error && <p className="error">{error}</p>}
        <label>
          {t('signup.name')}
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          {t('login.email')}
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          {t('login.password')}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
        </label>
        {captchaRequired && (
          <Turnstile siteKey={captchaConfig.siteKey} onToken={setCaptchaToken} />
        )}
        <button type="submit" disabled={loading || !captchaSatisfied}>
          {loading ? t('signup.submitting') : t('signup.submit')}
        </button>
        <div className="divider">
          <span>{t('common.or')}</span>
        </div>
        <a href="/api/auth/google" className="btn-secondary button">
          {t('login.continueWithGoogle')}
        </a>
        <Link to="/login">{t('login.backToLogin')}</Link>
      </form>
    </div>
  )
}
