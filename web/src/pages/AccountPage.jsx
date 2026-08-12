import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { apiFetch } from '../api/client'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { usePushSubscription } from '../hooks/usePushSubscription'
import { useDriveBackup } from '../hooks/useDriveBackup'

const DRIVE_ERROR_KEYS = {
  invalid_state: 'account.driveErrorInvalidState',
  drive_exchange_failed: 'account.driveErrorExchange',
  no_refresh_token: 'account.driveErrorNoRefreshToken',
  drive_not_configured: 'account.driveErrorUnconfigured',
}

export function AccountPage() {
  const { token, user } = useAuth()
  const { t } = useLanguage()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState(null)
  const [message, setMessage] = useState(null)
  const [loading, setLoading] = useState(false)
  const [searchParams] = useSearchParams()

  const push = usePushSubscription(token)
  const drive = useDriveBackup(token)

  const driveErrorCode = searchParams.get('driveError')
  const driveError = driveErrorCode ? t(DRIVE_ERROR_KEYS[driveErrorCode] || 'account.driveErrorGeneric') : null

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

        <h2>{t('account.driveBackup')}</h2>
        <p className="friends-caption">{t('account.driveBackupDescription')}</p>
        {driveError && <p className="error">{driveError}</p>}
        {drive.error && <p className="error">{drive.error}</p>}
        {drive.status === 'connected' && (
          <>
            <p className="notice">
              {t('account.driveConnectedSince', {
                date: drive.connectedAt ? new Date(drive.connectedAt).toLocaleString() : '',
              })}
            </p>
            {drive.lastSync && (
              <p className="friends-caption">
                {drive.lastSync.messagesArchived > 0
                  ? t('account.driveSyncResult', { count: drive.lastSync.messagesArchived })
                  : t('account.driveSyncResultNone')}
              </p>
            )}
            <button type="button" className="btn-secondary" disabled={drive.busy} onClick={drive.sync}>
              {drive.busy ? t('common.loading') : t('account.driveSyncNow')}
            </button>
            <button type="button" className="btn-secondary" disabled={drive.busy} onClick={drive.disconnect}>
              {drive.busy ? t('common.loading') : t('account.driveDisconnect')}
            </button>
          </>
        )}
        {drive.status === 'disconnected' && (
          <>
            <p className="friends-caption">{t('account.driveNotConnected')}</p>
            <button type="button" className="btn-secondary" disabled={drive.busy} onClick={drive.connect}>
              {drive.busy ? t('common.loading') : t('account.driveConnect')}
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
