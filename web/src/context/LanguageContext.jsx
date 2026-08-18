import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { translations } from '../i18n/translations'

const LanguageContext = createContext(null)

export function LanguageProvider({ children }) {
  const [language, setLanguage] = useState(() => localStorage.getItem('language') || 'en')

  // Keeps screen readers on the right pronunciation profile — without this,
  // <html lang> stays at index.html's static "en" no matter what the app
  // itself is rendering.
  useEffect(() => {
    document.documentElement.lang = language
  }, [language])

  const changeLanguage = useCallback((lang) => {
    setLanguage(lang)
    localStorage.setItem('language', lang)
  }, [])

  // Optional {placeholder} interpolation: t('chat.noMatches', { query }).
  // Callers that pass no vars behave exactly as before.
  const t = useCallback(
    (key, vars) => {
      const template = translations[language]?.[key] ?? translations.en[key] ?? key
      if (!vars) return template
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
      )
    },
    [language]
  )

  return (
    <LanguageContext.Provider value={{ language, setLanguage: changeLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage() {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider')
  return ctx
}
