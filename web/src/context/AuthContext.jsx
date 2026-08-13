import { createContext, useContext, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch, onUnauthorized } from '../api/client'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem('token'))
  const [user, setUser] = useState(() => {
    const stored = localStorage.getItem('user')
    return stored ? JSON.parse(stored) : null
  })
  const navigate = useNavigate()

  useEffect(() => {
    if (token) localStorage.setItem('token', token)
    else localStorage.removeItem('token')
  }, [token])

  useEffect(() => {
    if (user) localStorage.setItem('user', JSON.stringify(user))
    else localStorage.removeItem('user')
  }, [user])

  useEffect(() => {
    onUnauthorized(() => {
      setToken(null)
      setUser(null)
      navigate('/login')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Refresh the cached user on load so sessions stored before a field was
  // added to the user payload pick it up without needing to log out and back in.
  // `cancelled` guards against a slow response landing after `token` has
  // already moved on (e.g. logout, or a fast logout+login as a different
  // account on the same tab) and overwriting the new session's user with
  // the old one's.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    apiFetch('/auth/me', { token })
      .then((freshUser) => {
        if (!cancelled) setUser(freshUser)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [token])

  async function login(email, password) {
    const data = await apiFetch('/auth/login', { method: 'POST', body: { email, password } })
    setToken(data.token)
    setUser(data.user)
  }

  async function signup(email, password, name) {
    const data = await apiFetch('/auth/signup', { method: 'POST', body: { email, password, name } })
    setToken(data.token)
    setUser(data.user)
  }

  // Exchanges the short-lived ticket GET /auth/google/callback redirected the
  // browser with (see OAuthCallbackPage) for a real token, the same
  // ticket->JWT handoff src/routes/chat.js's SSE stream uses.
  async function loginWithGoogleTicket(ticket) {
    const data = await apiFetch('/auth/google/exchange', { method: 'POST', body: { ticket } })
    setToken(data.token)
    setUser(data.user)
  }

  function logout() {
    setToken(null)
    setUser(null)
  }

  // For a caller that just changed something about the account server-side
  // (e.g. AccountPage after PATCH /users/me) and has the new field values in
  // hand already — merges rather than refetching, since a full /auth/me
  // round-trip for one changed field is unnecessary.
  function updateUser(partial) {
    setUser((prev) => (prev ? { ...prev, ...partial } : prev))
  }

  return (
    <AuthContext.Provider value={{ token, user, login, signup, loginWithGoogleTicket, logout, updateUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
