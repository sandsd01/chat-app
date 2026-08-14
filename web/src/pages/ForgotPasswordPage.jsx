import { useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../api/client'
import { useLanguage } from '../context/LanguageContext'
import { AuthBrand } from '../components/AuthBrand'

export function ForgotPasswordPage() {
  const { t } = useLanguage()
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setMessage(null)
    setLoading(true)
    try {
      const result = await apiFetch('/auth/forgot-password', { method: 'POST', body: { email } })
      setMessage(result.message)
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
        <h1>{t('forgotPassword.title')}</h1>
        <p className="hint">{t('forgotPassword.description')}</p>
        {error && <p className="error">{error}</p>}
        {message && <p className="notice">{message}</p>}
        <label>
          {t('login.email')}
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <button type="submit" disabled={loading}>
          {loading ? t('common.loading') : t('forgotPassword.submit')}
        </button>
        <Link to="/login">{t('login.backToLogin')}</Link>
      </form>
    </div>
  )
}
