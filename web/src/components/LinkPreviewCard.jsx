import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { fetchLinkPreviewImage } from '../api/chat'

export default function LinkPreviewCard({ preview, conversationId, messageId }) {
  const { token } = useAuth()
  const [imageUrl, setImageUrl] = useState(null)

  // The thumbnail can't be a plain <img src="/api/...">: that route is behind
  // the JWT middleware and an <img> has no way to send an Authorization
  // header — exactly the constraint that pushed EventSource onto the
  // stream-ticket pattern. Fetching the bytes here and handing the <img> a
  // blob: URL (already allowed by the app's CSP) avoids inventing a second
  // ticket system just for images.
  useEffect(() => {
    if (!preview?.hasImage || !token) return undefined

    let objectUrl = null
    let cancelled = false

    fetchLinkPreviewImage(conversationId, messageId, token)
      .then((blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setImageUrl(objectUrl)
      })
      // A thumbnail that won't load just leaves a text-only card — the title
      // and description are the useful part and are already rendered.
      .catch(() => {})

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [preview?.hasImage, conversationId, messageId, token])

  if (!preview) return null

  return (
    <a className="chat-link-preview" href={preview.url} target="_blank" rel="noopener noreferrer">
      {imageUrl && <img className="chat-link-preview-image" src={imageUrl} alt="" />}
      <span className="chat-link-preview-text">
        {preview.siteName && <span className="chat-link-preview-site">{preview.siteName}</span>}
        {preview.title && <span className="chat-link-preview-title">{preview.title}</span>}
        {preview.description && <span className="chat-link-preview-description">{preview.description}</span>}
      </span>
    </a>
  )
}
