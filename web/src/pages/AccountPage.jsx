import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../api/client'
import {
  setCustomPublicId,
  setStatusMessage,
  uploadAvatar,
  removeAvatar,
  deleteAccount,
} from '../api/users'
import { listPushSubscriptions, deletePushSubscription } from '../api/push'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { usePushSubscription } from '../hooks/usePushSubscription'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { TicketId } from '../components/TicketId'
import { Avatar } from '../components/Avatar'

const PUBLIC_ID_PATTERN = /^[a-zA-Z0-9]{4,20}$/
const STATUS_MESSAGE_MAX_LENGTH = 80

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

  // Seeded from the loaded profile once, then owned by the input — a
  // controlled field can't re-sync from `user` on every render without
  // fighting what's being typed.
  const [status, setStatus] = useState(user?.statusMessage || '')
  const [statusBusy, setStatusBusy] = useState(false)
  const [statusSaved, setStatusSaved] = useState(false)
  const [statusError, setStatusError] = useState(null)

  const [avatarBusy, setAvatarBusy] = useState(false)
  const [avatarError, setAvatarError] = useState(null)
  const fileInputRef = useRef(null)

  const [devices, setDevices] = useState([])
  const [devicesError, setDevicesError] = useState(null)
  const [devicesBusyId, setDevicesBusyId] = useState(null)

  const push = usePushSubscription(token)

  const refreshDevices = useCallback(async () => {
    setDevicesError(null)
    try {
      setDevices(await listPushSubscriptions(token))
    } catch (err) {
      setDevicesError(err.message)
    }
  }, [token])

  // Re-fetched when the current browser's own subscription state flips, so
  // enabling/disabling notifications here shows up in the list immediately
  // rather than only after a reload.
  useEffect(() => {
    refreshDevices()
  }, [refreshDevices, push.status])

  async function handleSaveStatus() {
    setStatusError(null)
    setStatusSaved(false)
    setStatusBusy(true)
    try {
      const res = await setStatusMessage(status.trim() || null, token)
      updateUser({ statusMessage: res.statusMessage })
      setStatus(res.statusMessage || '')
      setStatusSaved(true)
    } catch (err) {
      setStatusError(err.message)
    } finally {
      setStatusBusy(false)
    }
  }

  async function handleAvatarChange(event) {
    const file = event.target.files?.[0]
    // Clear immediately so picking the same file again still fires onChange.
    event.target.value = ''
    if (!file) return

    setAvatarError(null)
    setAvatarBusy(true)
    try {
      const res = await uploadAvatar(file, token)
      updateUser({ avatarUrl: res.avatarUrl })
    } catch (err) {
      setAvatarError(err.message)
    } finally {
      setAvatarBusy(false)
    }
  }

  async function handleRemoveAvatar() {
    setAvatarError(null)
    setAvatarBusy(true)
    try {
      await removeAvatar(token)
      updateUser({ avatarUrl: null })
    } catch (err) {
      setAvatarError(err.message)
    } finally {
      setAvatarBusy(false)
    }
  }

  async function handleRevokeDevice(id) {
    setDevicesError(null)
    setDevicesBusyId(id)
    try {
      await deletePushSubscription(id, token)
      await refreshDevices()
    } catch (err) {
      setDevicesError(err.message)
    } finally {
      setDevicesBusyId(null)
    }
  }

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

        <hr className="section-divider" />
        <h2>{t('account.profilePhoto')}</h2>
        {avatarError && <p className="error" role="alert">{avatarError}</p>}
        <div className="avatar-editor">
          <Avatar user={user} size="lg" />
          <div>
            {/* The visible control is the button; the file input itself is
                kept out of the tab order so there aren't two focus stops for
                one action. */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
              onChange={handleAvatarChange}
              hidden
              tabIndex={-1}
            />
            <button
              type="button"
              className="btn-secondary"
              disabled={avatarBusy}
              onClick={() => fileInputRef.current?.click()}
            >
              {avatarBusy ? t('common.loading') : t('account.uploadPhoto')}
            </button>
            {user?.avatarUrl && (
              <button type="button" className="btn-secondary" disabled={avatarBusy} onClick={handleRemoveAvatar}>
                {t('account.removePhoto')}
              </button>
            )}
            <p className="friends-caption">{t('account.photoHint')}</p>
          </div>
        </div>

        <hr className="section-divider" />
        <h2>{t('account.statusMessage')}</h2>
        {statusError && <p className="error" role="alert">{statusError}</p>}
        {statusSaved && <p className="notice">{t('account.statusSaved')}</p>}
        <label>
          {t('account.statusMessageLabel')}
          <input
            type="text"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value)
              setStatusSaved(false)
            }}
            placeholder={t('account.statusPlaceholder')}
            maxLength={STATUS_MESSAGE_MAX_LENGTH}
          />
        </label>
        <p className="friends-caption">
          {t('account.statusHint', { remaining: STATUS_MESSAGE_MAX_LENGTH - status.length })}
        </p>
        <button type="button" className="btn-secondary" disabled={statusBusy} onClick={handleSaveStatus}>
          {statusBusy ? t('common.loading') : t('account.saveStatus')}
        </button>

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

        {/* Every browser this account has enabled notifications in — the
            button above only ever affects the one you're using now, so this
            is how an old phone or a shared computer gets revoked. */}
        <h3>{t('account.notificationDevices')}</h3>
        {devicesError && <p className="error" role="alert">{devicesError}</p>}
        {devices.length === 0 ? (
          <p className="friends-caption">{t('account.noDevices')}</p>
        ) : (
          <ul className="device-list">
            {devices.map((d) => (
              <li key={d.id} className="device-row">
                <span>
                  {d.device}
                  <span className="device-meta"> · {new Date(d.createdAt).toLocaleDateString()}</span>
                </span>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={devicesBusyId === d.id}
                  onClick={() => handleRevokeDevice(d.id)}
                >
                  {devicesBusyId === d.id ? t('common.loading') : t('account.revokeDevice')}
                </button>
              </li>
            ))}
          </ul>
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
