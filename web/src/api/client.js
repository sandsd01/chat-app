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

  let res
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    // fetch() itself throws (offline, DNS failure, CORS) rather than
    // resolving with a bad status — status 0 distinguishes this from any
    // real HTTP response for a caller that wants to branch on it.
    throw new ApiError('Network error — check your connection and try again.', 0)
  }

  notifyIfUnauthorized(res.status, Boolean(token))

  if (res.status === 204) return null

  const data = await res.json().catch(() => null)

  if (!res.ok) {
    // The server's own `error` string is preferred when present; this
    // fallback only fires for a response with no parseable JSON body (a
    // proxy timeout, a raw 500 page) — surface something actionable rather
    // than the raw HTTP status code.
    throw new ApiError(data?.error || 'Something went wrong. Please try again.', res.status)
  }

  return data
}
