import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'

export function SignupPage() {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const { signup } = useAuth()
  const { t } = useLanguage()
  const navigate = useNavigate()

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await signup(email, password, name)
      navigate('/')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="centered">
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
        <button type="submit" disabled={loading}>
          {loading ? t('signup.submitting') : t('signup.submit')}
        </button>
        <Link to="/login">{t('login.backToLogin')}</Link>
      </form>
    </div>
  )
}
