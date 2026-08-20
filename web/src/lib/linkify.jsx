// Message bodies render as plain text, so a pasted URL was previously not
// even clickable. Split on URLs and render those segments as real anchors.
//
// The capturing group is what makes String.split keep the delimiters, so the
// output alternates plain text and matched URLs rather than dropping them.
const URL_PATTERN = /(\bhttps?:\/\/[^\s<>"']+)/gi

export function linkifyText(text) {
  if (!text) return text
  return String(text)
    .split(URL_PATTERN)
    .map((segment, index) => {
      if (!/^https?:\/\//i.test(segment)) return segment
      // Trailing punctuation is far more often the sentence's than the URL's
      // — same trim as src/lib/linkPreview.js#extractFirstUrl, so the text
      // that becomes a link matches the text that gets unfurled.
      const trimmed = segment.replace(/[.,;:!?)\]}>]+$/, '')
      const trailing = segment.slice(trimmed.length)
      return (
        <span key={index}>
          <a href={trimmed} target="_blank" rel="noopener noreferrer">
            {trimmed}
          </a>
          {trailing}
        </span>
      )
    })
}
