import { useEffect, useRef, useState } from 'react'

// A flat, curated set rather than a full Unicode emoji library/package: the
// composer just needs "pick a common emoji and insert it into the text I'm
// already typing," not search or skin-tone variants, so a small bundled list
// keeps this dependency-free. Each entry carries an English accessible name
// since the glyph alone is announced as nothing useful (or its raw codepoint)
// by a screen reader.
const EMOJI = [
  { char: '😀', label: 'grinning face' },
  { char: '😂', label: 'face with tears of joy' },
  { char: '🥹', label: 'face holding back tears' },
  { char: '😊', label: 'smiling face with smiling eyes' },
  { char: '😍', label: 'heart eyes' },
  { char: '😘', label: 'face blowing a kiss' },
  { char: '😜', label: 'winking face with tongue' },
  { char: '🤔', label: 'thinking face' },
  { char: '😎', label: 'smiling face with sunglasses' },
  { char: '🥳', label: 'partying face' },
  { char: '😢', label: 'crying face' },
  { char: '😭', label: 'loudly crying face' },
  { char: '😡', label: 'pouting face' },
  { char: '😴', label: 'sleeping face' },
  { char: '🤗', label: 'hugging face' },
  { char: '🙄', label: 'face with rolling eyes' },
  { char: '😇', label: 'smiling face with halo' },
  { char: '🤩', label: 'star-struck' },
  { char: '🥰', label: 'smiling face with hearts' },
  { char: '😅', label: 'grinning face with sweat' },
  { char: '👍', label: 'thumbs up' },
  { char: '👎', label: 'thumbs down' },
  { char: '👏', label: 'clapping hands' },
  { char: '🙏', label: 'folded hands' },
  { char: '💪', label: 'flexed biceps' },
  { char: '🤝', label: 'handshake' },
  { char: '👋', label: 'waving hand' },
  { char: '✌️', label: 'victory hand' },
  { char: '🤞', label: 'crossed fingers' },
  { char: '🫶', label: 'heart hands' },
  { char: '❤️', label: 'red heart' },
  { char: '🧡', label: 'orange heart' },
  { char: '💛', label: 'yellow heart' },
  { char: '💚', label: 'green heart' },
  { char: '💙', label: 'blue heart' },
  { char: '💜', label: 'purple heart' },
  { char: '🖤', label: 'black heart' },
  { char: '🤍', label: 'white heart' },
  { char: '💔', label: 'broken heart' },
  { char: '💕', label: 'two hearts' },
  { char: '🔥', label: 'fire' },
  { char: '✨', label: 'sparkles' },
  { char: '🎉', label: 'party popper' },
  { char: '🎂', label: 'birthday cake' },
  { char: '🎁', label: 'wrapped gift' },
  { char: '☀️', label: 'sun' },
  { char: '🌙', label: 'crescent moon' },
  { char: '⭐', label: 'star' },
  { char: '☕', label: 'hot beverage' },
  { char: '🍕', label: 'pizza' },
]

// Fixed to match .emoji-picker's grid-template-columns in index.css — arrow
// key navigation needs the same column count to move up/down by a row.
const COLUMNS = 5

// Closes on outside click / Escape, matching how the rest of the app's
// transient popovers behave (e.g. the friends lookup result card). Arrow
// keys move a roving tabindex around the grid (standard "grid of buttons"
// keyboard pattern) rather than leaving Tab as the only way to reach an
// emoji past the first.
export function EmojiPicker({ onSelect, onClose }) {
  const ref = useRef(null)
  const buttonRefs = useRef([])
  const [activeIndex, setActiveIndex] = useState(0)

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

  function moveFocus(nextIndex) {
    const clamped = Math.max(0, Math.min(EMOJI.length - 1, nextIndex))
    setActiveIndex(clamped)
    buttonRefs.current[clamped]?.focus()
  }

  function handleGridKeyDown(e) {
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault()
        moveFocus(activeIndex + 1)
        break
      case 'ArrowLeft':
        e.preventDefault()
        moveFocus(activeIndex - 1)
        break
      case 'ArrowDown':
        e.preventDefault()
        moveFocus(activeIndex + COLUMNS)
        break
      case 'ArrowUp':
        e.preventDefault()
        moveFocus(activeIndex - COLUMNS)
        break
      default:
        break
    }
  }

  return (
    <div className="emoji-picker" ref={ref} role="grid" aria-label="Emoji picker" onKeyDown={handleGridKeyDown}>
      {EMOJI.map((emoji, index) => (
        <button
          type="button"
          key={emoji.char}
          ref={(el) => (buttonRefs.current[index] = el)}
          className="emoji-picker-item"
          aria-label={emoji.label}
          tabIndex={index === activeIndex ? 0 : -1}
          onClick={() => onSelect(emoji.char)}
          onFocus={() => setActiveIndex(index)}
        >
          {emoji.char}
        </button>
      ))}
    </div>
  )
}
