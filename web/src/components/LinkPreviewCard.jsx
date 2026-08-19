// The thumbnail is served from our own origin (the server stored the bytes at
// resolve time), so the app's existing `img-src 'self'` CSP covers it with no
// change — and the reader's browser never contacts the linked site at all.
export default function LinkPreviewCard({ preview, conversationId, messageId }) {
  if (!preview) return null

  return (
    <a className="chat-link-preview" href={preview.url} target="_blank" rel="noopener noreferrer">
      {preview.hasImage && (
        <img
          className="chat-link-preview-image"
          src={`/api/chat/conversations/${conversationId}/messages/${messageId}/link-preview-image`}
          alt=""
        />
      )}
      <span className="chat-link-preview-text">
        {preview.siteName && <span className="chat-link-preview-site">{preview.siteName}</span>}
        {preview.title && <span className="chat-link-preview-title">{preview.title}</span>}
        {preview.description && <span className="chat-link-preview-description">{preview.description}</span>}
      </span>
    </a>
  )
}
