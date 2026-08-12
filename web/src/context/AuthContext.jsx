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
  useEffect(() => {
    if (!token) return
    apiFetch('/auth/me', { token })
      .then(setUser)
      .catch(() => {})
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

  return (
    <AuthContext.Provider value={{ token, user, login, signup, loginWithGoogleTicket, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
