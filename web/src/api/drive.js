import { apiFetch } from './client'

export function getDriveStatus(token) {
  return apiFetch('/drive/status', { token })
}

export function startDriveConnect(token) {
  return apiFetch('/drive/connect/start', { method: 'POST', token })
}

export function disconnectDrive(token) {
  return apiFetch('/drive/disconnect', { method: 'POST', token })
}

export function syncDriveNow(token) {
  return apiFetch('/drive/sync', { method: 'POST', token })
}
