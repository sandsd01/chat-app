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

// Shared by every paginated messages route below: `before`/`limit` (plus
// whatever extra params a caller passes, e.g. search's `q`) only end up in
// the query string when actually set, so an unset `before` never sends the
// literal string "undefined".
function pagingQuery({ before, limit, ...extra } = {}) {
  const params = new URLSearchParams(extra)
  if (before !== undefined && before !== null) params.set('before', String(before))
  if (limit !== undefined && limit !== null) params.set('limit', String(limit))
  return params.toString()
}

export function listMessages(conversationId, opts = {}, token) {
  const qs = pagingQuery(opts)
  return apiFetch(`/chat/conversations/${conversationId}/messages${qs ? `?${qs}` : ''}`, { token })
}

export function searchMessages(conversationId, { q, ...opts } = {}, token) {
  const qs = pagingQuery({ ...opts, q })
  return apiFetch(`/chat/conversations/${conversationId}/messages/search?${qs}`, { token })
}

// Falls back to the caller's own Google Drive archive once
// GET /chat/conversations/:id/messages has run out of Postgres rows — see
// CLAUDE.md. Same {data, hasMore, nextBefore} shape as listMessages, so
// callers can treat a page from either source identically.
export function listDriveHistory(conversationId, opts = {}, token) {
  const qs = pagingQuery(opts)
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

export function editMessage(conversationId, messageId, body, token) {
  return apiFetch(`/chat/conversations/${conversationId}/messages/${messageId}`, {
    method: 'PATCH',
    body: { body },
    token,
  })
}

export function deleteMessage(conversationId, messageId, token) {
  return apiFetch(`/chat/conversations/${conversationId}/messages/${messageId}`, { method: 'DELETE', token })
}

export function addReaction(conversationId, messageId, emoji, token) {
  return apiFetch(`/chat/conversations/${conversationId}/messages/${messageId}/reactions`, {
    method: 'POST',
    body: { emoji },
    token,
  })
}

export function removeReaction(conversationId, messageId, emoji, token) {
  return apiFetch(
    `/chat/conversations/${conversationId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
    { method: 'DELETE', token }
  )
}

export function markRead(conversationId, token) {
  return apiFetch(`/chat/conversations/${conversationId}/read`, { method: 'POST', token })
}

export function sendTyping(conversationId, token) {
  return apiFetch(`/chat/conversations/${conversationId}/typing`, { method: 'POST', token })
}

export function getStreamTicket(token) {
  return apiFetch('/chat/stream-ticket', { method: 'POST', token })
}
