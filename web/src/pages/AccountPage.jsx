import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../api/client'
import { setCustomPublicId, deleteAccount } from '../api/users'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { usePushSubscription } from '../hooks/usePushSubscription'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { TicketId } from '../components/TicketId'

const PUBLIC_ID_PATTERN = /^[a-zA-Z0-9]{4,20}$/

export function AccountPage() {
  const { token, user, updateUser, logout } = useAuth()
  const { t } = useLanguage()
  const navigate = useNavigate()
  useDocumentTitle(t('account.title'))
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState(null)
  const [message, setMessage] = useState(null)
  const [loading, setLoading] = useState(false)

  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState(null)

  const [customId, setCustomId] = useState('')
  const [customIdError, setCustomIdError] = useState(null)
  const [customIdSaved, setCustomIdSaved] = useState(false)
  const [customIdBusy, setCustomIdBusy] = useState(false)

  const [resendBusy, setResendBusy] = useState(false)
  const [resendMessage, setResendMessage] = useState(null)
  const [resendError, setResendError] = useState(null)

  const push = usePushSubscription(token)

  async function handleSetCustomId() {
    setCustomIdError(null)
    if (!PUBLIC_ID_PATTERN.test(customId)) {
      setCustomIdError(t('account.customIdHint'))
      return
    }
    setCustomIdBusy(true)
    try {
      const result = await setCustomPublicId(customId, token)
      updateUser({ publicId: result.publicId, publicIdCustomized: true })
      setCustomIdSaved(true)
    } catch (err) {
      setCustomIdError(err.message)
    } finally {
      setCustomIdBusy(false)
    }
  }

  async function handleResendVerification() {
    setResendError(null)
    setResendMessage(null)
    setResendBusy(true)
    try {
      const result = await apiFetch('/auth/resend-verification', { method: 'POST', token })
      setResendMessage(result.message)
    } catch (err) {
      setResendError(err.message)
    } finally {
      setResendBusy(false)
    }
  }

  // Backend refuses (409) rather than deleting once the account has any
  // chat history (src/routes/users.js#DELETE /users/me) — a DM thread has
  // no "detach and keep going" story. That message is shown as-is, not
  // rephrased, since it's already written for this exact screen.
  async function handleDeleteAccount() {
    if (!window.confirm(t('account.confirmDeleteAccount'))) return
    setDeleteError(null)
    setDeleteBusy(true)
    try {
      await deleteAccount(token)
      logout()
      navigate('/login')
    } catch (err) {
      setDeleteError(err.message)
      setDeleteBusy(false)
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setMessage(null)
    setLoading(true)
    const settingFirstPassword = !user?.hasPassword
    try {
      const body = settingFirstPassword ? { newPassword } : { currentPassword, newPassword }
      await apiFetch('/auth/password', { method: 'PATCH', body, token })
      setMessage(t(settingFirstPassword ? 'account.passwordSet' : 'account.passwordUpdated'))
      setCurrentPassword('')
      setNewPassword('')
      if (settingFirstPassword) updateUser({ hasPassword: true })
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
        <p className="friends-caption">{t('account.yourId')}</p>
        <TicketId id={user?.publicId} copyLabel={t('friends.copy')} copiedLabel={t('friends.copied')} />

        {!user?.emailVerifiedAt && (
          <div className="account-verify-banner">
            {resendMessage ? (
              <span>{resendMessage}</span>
            ) : (
              <>
                <span>{t('account.emailUnverified')}</span>
                {resendError && <span className="error" role="alert">{resendError}</span>}
                <button type="button" className="btn-secondary" disabled={resendBusy} onClick={handleResendVerification}>
                  {resendBusy ? t('common.loading') : t('account.resendVerification')}
                </button>
              </>
            )}
          </div>
        )}

        {!user?.publicIdCustomized && (
          <>
            {customIdSaved ? (
              <p className="notice">{t('account.customIdSuccess')}</p>
            ) : (
              <div className="account-custom-id">
                {customIdError && <p className="error" role="alert">{customIdError}</p>}
                <p className="friends-caption">{t('account.customIdHint')}</p>
                <input
                  type="text"
                  value={customId}
                  onChange={(e) => setCustomId(e.target.value)}
                  placeholder={t('account.customIdPlaceholder')}
                  maxLength={20}
                />
                <button type="button" className="btn-secondary" disabled={customIdBusy} onClick={handleSetCustomId}>
                  {customIdBusy ? t('common.loading') : t('account.setCustomId')}
                </button>
              </div>
            )}
          </>
        )}

        <hr className="section-divider" />
        <h2>{t('account.notifications')}</h2>
        {push.error && <p className="error" role="alert">{push.error}</p>}
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

        <hr className="section-divider" />
        <h2>{t(user?.hasPassword ? 'account.changePassword' : 'account.setPassword')}</h2>
        {!user?.hasPassword && <p className="friends-caption">{t('account.setPasswordHint')}</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {message && <p className="notice">{message}</p>}
        {user?.hasPassword && (
          <label>
            {t('account.currentPassword')}
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
          </label>
        )}
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
        <p className="friends-caption">{t('common.passwordHint')}</p>
        <button type="submit" disabled={loading}>
          {loading ? t('common.loading') : t(user?.hasPassword ? 'account.updatePassword' : 'account.setPassword')}
        </button>

        <hr className="section-divider" />
        <h2>{t('account.dangerZone')}</h2>
        <p className="friends-caption">{t('account.deleteAccountHint')}</p>
        {deleteError && <p className="error" role="alert">{deleteError}</p>}
        <button
          type="button"
          className="btn-secondary-danger"
          disabled={deleteBusy}
          onClick={handleDeleteAccount}
        >
          {deleteBusy ? t('common.loading') : t('account.deleteAccount')}
        </button>
      </form>
    </div>
  )
}
