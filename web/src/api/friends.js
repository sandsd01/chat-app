import { apiFetch } from './client'

// Thin wrappers over apiFetch for /api/friends (see src/routes/friends.js).

export function lookupByPublicId(publicId, token) {
  const params = new URLSearchParams({ publicId })
  return apiFetch(`/friends/lookup?${params.toString()}`, { token })
}

export function listFriends(token) {
  return apiFetch('/friends', { token })
}

export function listRequests(token) {
  return apiFetch('/friends/requests', { token })
}

export function sendFriendRequest(publicId, token) {
  return apiFetch('/friends/requests', { method: 'POST', body: { publicId }, token })
}

export function acceptFriendRequest(requestId, token) {
  return apiFetch(`/friends/requests/${requestId}/accept`, { method: 'POST', token })
}

export function declineFriendRequest(requestId, token) {
  return apiFetch(`/friends/requests/${requestId}/decline`, { method: 'POST', token })
}

export function cancelFriendRequest(requestId, token) {
  return apiFetch(`/friends/requests/${requestId}`, { method: 'DELETE', token })
}

export function removeFriend(userId, token) {
  return apiFetch(`/friends/${userId}`, { method: 'DELETE', token })
}

export function blockUser(userId, token) {
  return apiFetch(`/friends/${userId}/block`, { method: 'POST', token })
}

export function unblockUser(userId, token) {
  return apiFetch(`/friends/${userId}/unblock`, { method: 'POST', token })
}
