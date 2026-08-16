import { useEffect, useRef } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { useChat } from '../context/ChatContext'
import { useFriends } from '../context/FriendsContext'
import { AuthBrand } from './AuthBrand'

export function Layout() {
  const { user, logout } = useAuth()
  const { language, setLanguage, t } = useLanguage()
  const { unreadTotal } = useChat()
  const { incomingCount } = useFriends()
  const navigate = useNavigate()
  const location = useLocation()
  const mainRef = useRef(null)
  const isFirstRenderRef = useRef(true)

  // Move focus to the new view on every client-side navigation — React
  // Router doesn't reload the page, so without this a keyboard/screen-reader
  // user's focus is left on a now-unmounted control from the previous page.
  // Skipped on the very first render so page load doesn't steal focus away
  // from the skip link or the browser's own address bar.
  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false
      return
    }
    mainRef.current?.focus()
  }, [location.pathname])

  function handleLogout() {
    logout()
    navigate('/login')
  }

  return (
    <div className="layout">
      <a href="#main-content" className="skip-link">
        {t('nav.skipToContent')}
      </a>
      <nav className="navbar" aria-label={t('nav.mainNavigation')}>
        <AuthBrand compact />
        <NavLink to="/chat" className={({isActive}) => isActive ? "active" : undefined}>
          {t('nav.chat')}
          {unreadTotal > 0 && (
            <span className="chat-nav-badge" role="status" aria-live="polite">
              <span aria-hidden="true">{unreadTotal > 99 ? '99+' : unreadTotal}</span>
              <span className="sr-only">{t('nav.unreadCount', { count: unreadTotal })}</span>
            </span>
          )}
        </NavLink>
        <NavLink to="/friends" className={({isActive}) => isActive ? "active" : undefined}>
          {t('nav.friends')}
          {incomingCount > 0 && (
            <span className="chat-nav-badge" role="status" aria-live="polite">
              <span aria-hidden="true">{incomingCount > 99 ? '99+' : incomingCount}</span>
              <span className="sr-only">{t('nav.incomingCount', { count: incomingCount })}</span>
            </span>
          )}
        </NavLink>
        <span className="spacer" />
        <select
          className="language-select"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          aria-label={t('nav.language')}
        >
          <option value="en">EN</option>
          <option value="th">ไทย</option>
        </select>
        {user && (
          <>
            <NavLink to="/account" className="user-badge">
              {user.name || user.email}
            </NavLink>
            <button onClick={handleLogout}>{t('nav.logout')}</button>
          </>
        )}
      </nav>
      <main id="main-content" className="content" tabIndex={-1} ref={mainRef}>
        <Outlet />
      </main>
    </div>
  )
}
