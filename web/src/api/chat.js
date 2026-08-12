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

export function sendMessage(conversationId, body, token) {
  return apiFetch(`/chat/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: { body },
    token,
  })
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
