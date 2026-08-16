import { useEffect } from 'react'
import { useLanguage } from '../context/LanguageContext'

// React Router doesn't reload the page or otherwise announce a client-side
// route change, so a screen-reader user's only signal that navigation
// happened is the tab title changing. Every distinct browser-history entry
// getting the same title ("Chat", from web/index.html) also makes tabs and
// history indistinguishable from each other.
export function useDocumentTitle(pageTitle) {
  const { t } = useLanguage()
  useEffect(() => {
    document.title = pageTitle ? `${pageTitle} · ${t('common.appName')}` : t('common.appName')
  }, [pageTitle, t])
}
