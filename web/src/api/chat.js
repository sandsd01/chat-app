import { apiFetch } from './client'

// Thin wrappers over apiFetch for the 1:1 chat routes mounted at /api/chat
// (see src/routes/chat.js). Every function takes `token` last so call sites
// read `fnName(...args, token)`, matching how pages already pass `token`
// into apiFetch's options object.

export function listConversations(token) {
  return apiFetch('/chat/conversations', { token })
}

export function startConversation(userId, token) {
  return apiFetch('/chat/conversations', { method: 'POST', body: { userId }, token })
}

export function listMessages(conversationId, { before, limit } = {}, token) {
  const params = new URLSearchParams()
  if (before !== undefined && before !== null) params.set('before', String(before))
  if (limit !== undefined && limit !== null) params.set('limit', String(limit))
  const qs = params.toString()
  return apiFetch(`/chat/conversations/${conversationId}/messages${qs ? `?${qs}` : ''}`, { token })
}

// Falls back to the caller's own Google Drive archive once
// GET /chat/conversations/:id/messages has run out of Postgres rows — see
// CLAUDE.md. Same {data, hasMore, nextBefore} shape as listMessages, so
// callers can treat a page from either source identically.
export function listDriveHistory(conversationId, { before, limit } = {}, token) {
  const params = new URLSearchParams()
  if (before !== undefined && before !== null) params.set('before', String(before))
  if (limit !== undefined && limit !== null) params.set('limit', String(limit))
  const qs = params.toString()
  return apiFetch(`/chat/conversations/${conversationId}/messages/drive-history${qs ? `?${qs}` : ''}`, { token })
}

export function sendMessage(conversationId, { body, attachmentKey, attachmentName } = {}, token) {
  return apiFetch(`/chat/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: { body, attachmentKey, attachmentName },
    token,
  })
}

export function requestUpload(conversationId, { fileName, mimeType, size }, token) {
  return apiFetch('/chat/uploads', {
    method: 'POST',
    body: { conversationId, fileName, mimeType, size },
    token,
  })
}

// PUTs directly to R2 — not through apiFetch, since this isn't a /api call
// and doesn't take a bearer token (the presigned URL itself is the auth).
// Content-Type must match what was sent to requestUpload(), since it's
// bound into the presigned URL's signature.
export async function uploadFileToR2(url, file) {
  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })
  if (!res.ok) throw new Error('Upload failed')
}

export function markRead(conversationId, token) {
  return apiFetch(`/chat/conversations/${conversationId}/read`, { method: 'POST', token })
}

export function searchUsers(q, token) {
  const params = new URLSearchParams({ q })
  return apiFetch(`/chat/users?${params.toString()}`, { token })
}

export function getStreamTicket(token) {
  return apiFetch('/chat/stream-ticket', { method: 'POST', token })
}
