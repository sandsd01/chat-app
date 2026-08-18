import { apiFetch } from './client'

// Thin wrapper over apiFetch for /api/users (see src/routes/users.js).

export function setCustomPublicId(publicId, token) {
  return apiFetch('/users/me', { method: 'PATCH', body: { publicId }, token })
}

// Null clears it. Sent on its own (not alongside publicId) because the two
// fields have very different rules server-side — publicId is one-shot.
export function setStatusMessage(statusMessage, token) {
  return apiFetch('/users/me', { method: 'PATCH', body: { statusMessage }, token })
}

// Two steps like a chat attachment: ask for a presigned PUT, upload the file
// straight to R2 (never through our API), then tell the API the key landed.
export async function uploadAvatar(file, token) {
  const { url, key } = await apiFetch('/users/me/avatar/upload-url', {
    method: 'POST',
    body: { mimeType: file.type, size: file.size },
    token,
  })

  const res = await fetch(url, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': file.type },
  })
  if (!res.ok) throw new Error('Upload failed')

  return apiFetch('/users/me/avatar', { method: 'PUT', body: { key }, token })
}

export function removeAvatar(token) {
  return apiFetch('/users/me/avatar', { method: 'DELETE', token })
}

export function deleteAccount(token) {
  return apiFetch('/users/me', { method: 'DELETE', token })
}
