import { useEffect, useRef } from 'react'

// A flat, curated set rather than a full Unicode emoji library/package: the
// composer just needs "pick a common emoji and insert it into the text I'm
// already typing," not search or skin-tone variants, so a small bundled list
// keeps this dependency-free.
const EMOJI = [
  '😀', '😂', '🥹', '😊', '😍', '😘', '😜', '🤔', '😎', '🥳',
  '😢', '😭', '😡', '😴', '🤗', '🙄', '😇', '🤩', '🥰', '😅',
  '👍', '👎', '👏', '🙏', '💪', '🤝', '👋', '✌️', '🤞', '🫶',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '💕',
  '🔥', '✨', '🎉', '🎂', '🎁', '☀️', '🌙', '⭐', '☕', '🍕',
]

// Closes on outside click / Escape, matching how the rest of the app's
// transient popovers behave (e.g. the friends lookup result card).
export function EmojiPicker({ onSelect, onClose }) {
  const ref = useRef(null)

  useEffect(() => {
    function handlePointerDown(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    function handleKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  return (
    <div className="emoji-picker" ref={ref}>
      {EMOJI.map((emoji) => (
        <button type="button" key={emoji} className="emoji-picker-item" onClick={() => onSelect(emoji)}>
          {emoji}
        </button>
      ))}
    </div>
  )
}
