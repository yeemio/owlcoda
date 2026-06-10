import emojiRegex from 'emoji-regex'
import { eastAsianWidth } from 'get-east-asian-width'
import stripAnsi from 'strip-ansi'
import { getGraphemeSegmenter } from '../utils/intl.js'

const EMOJI_REGEX = emojiRegex()

// ─── East-Asian Ambiguous width (terminal-dependent) ────────────────
//
// Ambiguous-width glyphs (→ ≤ ⚠ │ ● ✓ … — East Asian Width "Ambiguous")
// render NARROW (1 cell) in Western/Latin terminals but WIDE (2 cells) in
// CJK-locale terminals. There is no single correct answer: it depends on
// the terminal the user is actually looking at. We default to NARROW
// (preserving prior behavior + the Unicode "Western context" default) and
// let a startup cursor-advance probe (or an explicit env override) flip it
// to WIDE when the real terminal renders these glyphs double-width.
//
// Getting this wrong by even one cell per ambiguous glyph desyncs the
// virtual screen from the physical terminal: pad/wrap/table-column math
// under-counts those rows, and the cursor-positioning that rides on it
// drifts → truncated rows, mis-aligned table borders, duplicated lines.
function readAmbiguousWidthEnv(): boolean | null {
  const v = process.env['OWLCODA_AMBIGUOUS_WIDTH']?.trim().toLowerCase()
  if (v === 'wide' || v === '2' || v === 'double') return true
  if (v === 'narrow' || v === '1' || v === 'single') return false
  return null
}
// Env override is the escape hatch: when set, it wins over the probe so a
// mis-firing detection can always be forced back by the user.
const ambiguousEnvOverride = readAmbiguousWidthEnv()
let ambiguousIsWide = ambiguousEnvOverride ?? false

type LocaleEnv = Record<string, string | undefined>

function localeLooksCjk(locale: string | undefined): boolean {
  const normalized = locale?.trim().toLowerCase()
  if (!normalized) return false

  const language = normalized.match(/^[a-z]{2,3}(?=$|[_.-])/)?.[0]
  return language === 'zh' || language === 'ja' || language === 'ko'
}

/** CJK locales commonly render East-Asian Ambiguous glyphs wide. */
export function shouldUseAmbiguousWidthWideLocaleFallback(
  env: LocaleEnv = process.env,
): boolean {
  return (
    localeLooksCjk(env['LC_ALL']) ||
    localeLooksCjk(env['LC_CTYPE']) ||
    localeLooksCjk(env['LANG'])
  )
}

/**
 * Apply a conservative fallback when the real terminal probe cannot decide.
 * Env override still wins; otherwise CJK locale metadata is better than
 * silently keeping the Western narrow default.
 */
export function applyAmbiguousWidthLocaleFallback(
  env: LocaleEnv = process.env,
): boolean {
  if (ambiguousEnvOverride !== null) return false
  if (!shouldUseAmbiguousWidthWideLocaleFallback(env)) return false
  ambiguousIsWide = true
  return true
}

/** Set whether ambiguous-width glyphs are measured WIDE (2) or NARROW (1).
 *  No-op when an env override (OWLCODA_AMBIGUOUS_WIDTH) is present. */
export function setAmbiguousWidthWide(wide: boolean): void {
  if (ambiguousEnvOverride !== null) return
  ambiguousIsWide = wide
}

/** Current ambiguous-width mode (true = wide). */
export function isAmbiguousWidthWide(): boolean {
  return ambiguousIsWide
}

/** Interpret a cursor-advance probe. One ambiguous glyph was written at
 *  column `before`; `after` is the cursor column read back via DSR.
 *  delta 2 → terminal renders ambiguous WIDE; 1 → NARROW; any other delta
 *  is implausible (wrap, garbled reply) → null so the caller keeps the
 *  default rather than acting on noise. */
export function interpretAmbiguousWidthProbe(
  before: number,
  after: number,
): boolean | null {
  const delta = after - before
  if (delta === 2) return true
  if (delta === 1) return false
  return null
}

/**
 * East Asian Width of one codepoint, honoring the ambiguous-wide flag —
 * EXCEPT Box Drawing (U+2500–257F) and Block Elements (U+2580–259F).
 * Those are classified Ambiguous by Unicode but terminals render them
 * NARROW even in CJK locale (otherwise every TUI box / table border would
 * double in width), and owlcoda's table-border + accent-bar layout math
 * hardcodes width 1 for them. Forcing them narrow keeps chrome aligned
 * while letting real ambiguous symbols (→ ≤ ● ① …) follow the terminal.
 */
function eawAmbiguous(codePoint: number): number {
  if (ambiguousIsWide && codePoint >= 0x2500 && codePoint <= 0x259f) {
    return 1
  }
  return eastAsianWidth(codePoint, { ambiguousAsWide: ambiguousIsWide })
}

/**
 * Fallback JavaScript implementation of stringWidth when Bun.stringWidth is not available.
 *
 * Get the display width of a string as it would appear in a terminal.
 *
 * This is a more accurate alternative to the string-width package that correctly handles
 * characters like ⚠ (U+26A0) which string-width incorrectly reports as width 2.
 *
 * Ambiguous-width characters default to narrow (width 1, the Unicode
 * "Western context" recommendation) but follow the module-level
 * `ambiguousIsWide` flag, which a startup terminal probe or the
 * OWLCODA_AMBIGUOUS_WIDTH env override flips to wide for CJK-locale
 * terminals that render those glyphs double-width.
 */
function stringWidthJavaScript(str: string): number {
  if (typeof str !== 'string' || str.length === 0) {
    return 0
  }

  // Fast path: pure ASCII string (no ANSI codes, no wide chars)
  let isPureAscii = true
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    // Check for non-ASCII or ANSI escape (0x1b)
    if (code >= 127 || code === 0x1b) {
      isPureAscii = false
      break
    }
  }
  if (isPureAscii) {
    // Count printable characters (exclude control chars)
    let width = 0
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i)
      if (code > 0x1f) {
        width++
      }
    }
    return width
  }

  // Strip ANSI if escape character is present
  if (str.includes('\x1b')) {
    str = stripAnsi(str)
    if (str.length === 0) {
      return 0
    }
  }

  // Fast path: simple Unicode (no emoji, variation selectors, or joiners)
  if (!needsSegmentation(str)) {
    let width = 0
    for (const char of str) {
      const codePoint = char.codePointAt(0)!
      if (!isZeroWidth(codePoint)) {
        width += eawAmbiguous(codePoint)
      }
    }
    return width
  }

  let width = 0

  for (const { segment: grapheme } of getGraphemeSegmenter().segment(str)) {
    // Check for emoji first (most emoji sequences are width 2)
    EMOJI_REGEX.lastIndex = 0
    if (EMOJI_REGEX.test(grapheme)) {
      width += getEmojiWidth(grapheme)
      continue
    }

    // Calculate width for non-emoji graphemes
    // For grapheme clusters (like Devanagari conjuncts with virama+ZWJ), only count
    // the first non-zero-width character's width since the cluster renders as one glyph
    for (const char of grapheme) {
      const codePoint = char.codePointAt(0)!
      if (!isZeroWidth(codePoint)) {
        width += eawAmbiguous(codePoint)
        break
      }
    }
  }

  return width
}

function needsSegmentation(str: string): boolean {
  for (const char of str) {
    const cp = char.codePointAt(0)!
    // Emoji ranges
    if (cp >= 0x1f300 && cp <= 0x1faff) return true
    if (cp >= 0x2600 && cp <= 0x27bf) return true
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return true
    // Variation selectors, ZWJ
    if (cp >= 0xfe00 && cp <= 0xfe0f) return true
    if (cp === 0x200d) return true
  }
  return false
}

function getEmojiWidth(grapheme: string): number {
  // Regional indicators: single = 1, pair = 2
  const first = grapheme.codePointAt(0)!
  if (first >= 0x1f1e6 && first <= 0x1f1ff) {
    let count = 0
    for (const _ of grapheme) count++
    return count === 1 ? 1 : 2
  }

  // Incomplete keycap: digit/symbol + VS16 without U+20E3
  if (grapheme.length === 2) {
    const second = grapheme.codePointAt(1)
    if (
      second === 0xfe0f &&
      ((first >= 0x30 && first <= 0x39) || first === 0x23 || first === 0x2a)
    ) {
      return 1
    }
  }

  // Default presentation (no VS16 emoji-presentation selector): the symbol
  // renders with its Unicode default, which East Asian Width already encodes —
  // default-text symbols like ⚠ (U+26A0) are Narrow (width 1); default-emoji
  // symbols like ⌚ ⭐ ✅ and all astral emoji are Wide (width 2). emoji-regex
  // matches both, so without this the text-default symbols were over-counted as
  // width 2, desyncing cell layout from the terminal. A VS16 (U+FE0F) request
  // for emoji presentation still forces width 2 (handled by the fall-through).
  const hasEmojiSelector = [...grapheme].some(
    ch => ch.codePointAt(0) === 0xfe0f,
  )
  if (!hasEmojiSelector) {
    return eawAmbiguous(first)
  }

  return 2
}

function isZeroWidth(codePoint: number): boolean {
  // Fast path for common printable range
  if (codePoint >= 0x20 && codePoint < 0x7f) return false
  if (codePoint >= 0xa0 && codePoint < 0x0300) return codePoint === 0x00ad

  // Control characters
  if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true

  // Zero-width and invisible characters
  if (
    (codePoint >= 0x200b && codePoint <= 0x200d) || // ZW space/joiner
    codePoint === 0xfeff || // BOM
    (codePoint >= 0x2060 && codePoint <= 0x2064) // Word joiner etc.
  ) {
    return true
  }

  // Variation selectors
  if (
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  ) {
    return true
  }

  // Combining diacritical marks
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  ) {
    return true
  }

  // Indic script combining marks (covers Devanagari through Malayalam)
  if (codePoint >= 0x0900 && codePoint <= 0x0d4f) {
    // Signs and vowel marks at start of each script block
    const offset = codePoint & 0x7f
    if (offset <= 0x03) return true // Signs at block start
    if (offset >= 0x3a && offset <= 0x4f) return true // Vowel signs, virama
    if (offset >= 0x51 && offset <= 0x57) return true // Stress signs
    if (offset >= 0x62 && offset <= 0x63) return true // Vowel signs
  }

  // Thai/Lao combining marks
  // Note: U+0E32 (SARA AA), U+0E33 (SARA AM), U+0EB2, U+0EB3 are spacing vowels (width 1), not combining marks
  if (
    codePoint === 0x0e31 || // Thai MAI HAN-AKAT
    (codePoint >= 0x0e34 && codePoint <= 0x0e3a) || // Thai vowel signs (skip U+0E32, U+0E33)
    (codePoint >= 0x0e47 && codePoint <= 0x0e4e) || // Thai vowel signs and marks
    codePoint === 0x0eb1 || // Lao MAI KAN
    (codePoint >= 0x0eb4 && codePoint <= 0x0ebc) || // Lao vowel signs (skip U+0EB2, U+0EB3)
    (codePoint >= 0x0ec8 && codePoint <= 0x0ecd) // Lao tone marks
  ) {
    return true
  }

  // Arabic formatting
  if (
    (codePoint >= 0x0600 && codePoint <= 0x0605) ||
    codePoint === 0x06dd ||
    codePoint === 0x070f ||
    codePoint === 0x08e2
  ) {
    return true
  }

  // Surrogates, tag characters
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true
  if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return true

  return false
}

// Note: complex-script graphemes like Devanagari क्ष (ka+virama+ZWJ+ssa) render
// as a single ligature glyph but occupy 2 terminal cells (wcwidth sums the base
// consonants). Bun.stringWidth=2 matches terminal cell allocation, which is what
// we need for cursor positioning — the JS fallback's grapheme-cluster width of 1
// would desync Ink's layout from the terminal.
//
// Bun.stringWidth is resolved once at module scope rather than checked on every
// call — typeof guards deopt property access and this is a hot path (~100k calls/frame).
const bunStringWidth =
  typeof Bun !== 'undefined' && typeof Bun.stringWidth === 'function'
    ? Bun.stringWidth
    : null

const BUN_OPTS_AMBIGUOUS_NARROW = { ambiguousIsNarrow: true } as const

export const stringWidth: (str: string) => number = bunStringWidth
  ? str =>
      // Wide mode needs the Box-Drawing / Block-Elements exclusion, which
      // Bun's bulk stringWidth can't express — route wide mode through the
      // JS path. Narrow mode (default / common case) stays on fast Bun.
      ambiguousIsWide
        ? stringWidthJavaScript(str)
        : bunStringWidth(str, BUN_OPTS_AMBIGUOUS_NARROW)
  : stringWidthJavaScript
