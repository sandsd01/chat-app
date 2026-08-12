import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { StreamProvider } from './context/StreamContext'
import { LanguageProvider } from './context/LanguageContext'
import { ChatProvider } from './context/ChatContext'
import { FriendsProvider } from './context/FriendsContext'
import { RequireAuth } from './components/RequireAuth'
import { Layout } from './components/Layout'
import { LoginPage } from './pages/LoginPage'
import { SignupPage } from './pages/SignupPage'
import { ForgotPasswordPage } from './pages/ForgotPasswordPage'
import { ResetPasswordPage } from './pages/ResetPasswordPage'
import { OAuthCallbackPage } from './pages/OAuthCallbackPage'
import { AccountPage } from './pages/AccountPage'
import { ChatPage } from './pages/ChatPage'
import { FriendsPage } from './pages/FriendsPage'

function App() {
  return (
    <BrowserRouter>
      <LanguageProvider>
        <AuthProvider>
          <StreamProvider>
            <ChatProvider>
              <FriendsProvider>
                <Routes>
                  <Route path="/login" element={<LoginPage />} />
                  <Route path="/signup" element={<SignupPage />} />
                  <Route path="/forgot-password" element={<ForgotPasswordPage />} />
                  <Route path="/reset-password" element={<ResetPasswordPage />} />
                  <Route path="/oauth-callback" element={<OAuthCallbackPage />} />

                  <Route element={<RequireAuth />}>
                    <Route element={<Layout />}>
                      <Route path="/" element={<Navigate to="/chat" replace />} />
                      <Route path="/chat" element={<ChatPage />} />
                      <Route path="/chat/:conversationId" element={<ChatPage />} />
                      <Route path="/friends" element={<FriendsPage />} />
                      <Route path="/account" element={<AccountPage />} />
                    </Route>
                  </Route>

                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </FriendsProvider>
            </ChatProvider>
          </StreamProvider>
        </AuthProvider>
      </LanguageProvider>
    </BrowserRouter>
  )
}

export default App
