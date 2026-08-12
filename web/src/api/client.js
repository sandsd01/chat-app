const BASE_URL = '/api'

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

let unauthorizedHandler = null

// Registered by AuthContext so an expired/invalid token can trigger an
// auto-logout + redirect to login. Only fires for requests that carried a
// token, so a plain wrong-password 401 on /auth/login doesn't log anyone out.
export function onUnauthorized(handler) {
  unauthorizedHandler = handler
}

function notifyIfUnauthorized(status, hadToken) {
  if (status === 401 && hadToken) unauthorizedHandler?.()
}

export async function apiFetch(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  notifyIfUnauthorized(res.status, Boolean(token))

  if (res.status === 204) return null

  const data = await res.json().catch(() => null)

  if (!res.ok) {
    throw new ApiError(data?.error || `Request failed with status ${res.status}`, res.status)
  }

  return data
}
