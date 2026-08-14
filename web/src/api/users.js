import { apiFetch } from './client'

// Thin wrapper over apiFetch for /api/users (see src/routes/users.js).

export function setCustomPublicId(publicId, token) {
  return apiFetch('/users/me', { method: 'PATCH', body: { publicId }, token })
}

export function deleteAccount(token) {
  return apiFetch('/users/me', { method: 'DELETE', token })
}
