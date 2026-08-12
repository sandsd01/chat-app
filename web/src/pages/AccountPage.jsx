import { useState } from 'react'
import { apiFetch } from '../api/client'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { usePushSubscription } from '../hooks/usePushSubscription'

export function AccountPage() {
  const { token, user } = useAuth()
  const { t } = useLanguage()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState(null)
  const [message, setMessage] = useState(null)
  const [loading, setLoading] = useState(false)

  const push = usePushSubscription(token)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setMessage(null)
    setLoading(true)
    try {
      await apiFetch('/auth/password', {
        method: 'PATCH',
        body: { currentPassword, newPassword },
        token,
      })
      setMessage('Password updated.')
      setCurrentPassword('')
      setNewPassword('')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="centered">
      <form className="card" onSubmit={handleSubmit}>
        <h1>{t('account.title')}</h1>
        <p>
          {t('account.signedInAs')} <strong>{user?.name || user?.email}</strong>
        </p>

        <h2>{t('account.notifications')}</h2>
        {push.error && <p className="error">{push.error}</p>}
        {push.status === 'unsupported' && <p className="friends-caption">{t('account.pushUnsupported')}</p>}
        {push.status === 'denied' && <p className="friends-caption">{t('account.pushDenied')}</p>}
        {push.status === 'unsubscribed' && (
          <button type="button" className="btn-secondary" disabled={push.busy} onClick={push.subscribe}>
            {push.busy ? t('common.loading') : t('account.enableNotifications')}
          </button>
        )}
        {push.status === 'subscribed' && (
          <>
            <p className="notice">{t('account.notificationsEnabled')}</p>
            <button type="button" className="btn-secondary" disabled={push.busy} onClick={push.unsubscribe}>
              {push.busy ? t('common.loading') : t('account.disableNotifications')}
            </button>
          </>
        )}

        <h2>{t('account.changePassword')}</h2>
        {error && <p className="error">{error}</p>}
        {message && <p className="notice">{message}</p>}
        <label>
          {t('account.currentPassword')}
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
        </label>
        <label>
          {t('account.newPassword')}
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            minLength={8}
            required
          />
        </label>
        <button type="submit" disabled={loading}>
          {loading ? '…' : t('account.updatePassword')}
        </button>
      </form>
    </div>
  )
}
