import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { useChat } from '../context/ChatContext'
import { useFriends } from '../context/FriendsContext'

export function Layout() {
  const { user, logout } = useAuth()
  const { language, setLanguage, t } = useLanguage()
  const { unreadTotal } = useChat()
  const { incomingCount } = useFriends()
  const navigate = useNavigate()

  function handleLogout() {
    logout()
    navigate('/login')
  }

  return (
    <div className="layout">
      <nav className="navbar">
        <NavLink to="/chat" className={({isActive}) => isActive ? "active" : undefined}>
          {t('nav.chat')}
          {unreadTotal > 0 && <span className="chat-nav-badge">{unreadTotal > 99 ? '99+' : unreadTotal}</span>}
        </NavLink>
        <NavLink to="/friends" className={({isActive}) => isActive ? "active" : undefined}>
          {t('nav.friends')}
          {incomingCount > 0 && <span className="chat-nav-badge">{incomingCount > 99 ? '99+' : incomingCount}</span>}
        </NavLink>
        <span className="spacer" />
        <select
          className="language-select"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          aria-label="Language"
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
      <main className="content">
        <Outlet />
      </main>
    </div>
  )
}
