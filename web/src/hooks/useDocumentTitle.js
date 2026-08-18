import { useEffect } from 'react'

// The <title> was a static "Chat" everywhere, so a browser/OS tab switcher
// couldn't tell one open page from another. `title` is already translated
// by the caller (useLanguage()'s t()) so this stays language-agnostic.
export function useDocumentTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} · Chat` : 'Chat'
  }, [title])
}
