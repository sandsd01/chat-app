export function localeFor(language) {
  return language === 'th' ? 'th-TH' : 'en-US'
}

// Shape a deleted message's body/attachment fields are reset to on the
// client — mirrors what DELETE /chat/conversations/:id/messages/:messageId
// clears server-side, kept in one place so a new attachment field doesn't
// need remembering to null it in every optimistic-update call site too.
export const CLEARED_ATTACHMENT_FIELDS = {
  body: null,
  attachmentType: null,
  attachmentUrl: null,
  attachmentKey: null,
  attachmentName: null,
}

export function initials(nameOrEmail) {
  const source = (nameOrEmail || '').trim()
  if (!source) return '?'
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return source.slice(0, 2).toUpperCase()
}
