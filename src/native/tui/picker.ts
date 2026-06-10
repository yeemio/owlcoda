/**
 * OwlCoda TUI Fuzzy Picker
 *
 * Interactive searchable list picker for terminal UIs.
 * Clean-room implementation — imperative ANSI rendering,
 * no React/Ink dependency.
 *
 * Features:
 * - Fuzzy text search filtering
 * - Arrow key / j/k navigation
 * - Optional preview pane
 * - Configurable visible rows (auto-fits terminal)
 * - Enter to select, Esc to cancel
 */

import { sgr, themeColor, dim } from './colors.js'
import { truncate } from './text.js'
import { visibleWidth } from './colors.js'
import { formatKeyHint } from './message.js'

// ─── Types ────────────────────────────────────────────────────

export interface PickerItem<T = unknown> {
  /** Display label (may contain ANSI). */
  label: string
  /** Optional description (shown dimmed after label). */
  description?: string
  /** The underlying value returned on selection. */
  value: T
  /**
   * Per-variant metadata used by `InkPicker`'s typed grids:
   *   - `tag`      → small uppercase pill on the right (file/dir, fast/default/max, current).
   *   - `shortcut` → keyboard shortcut text on the right (slash picker).
   *   - `meta`     → secondary descriptor (model: "200k ctx · $3.00/M").
   * All are optional so the generic picker keeps working with two-field items.
   */
  tag?: string
  shortcut?: string
  meta?: string
}

export interface PickerOptions<T = unknown> {
  /** Title shown above the search box. */
  title?: string
  /** Items to pick from. */
  items: PickerItem<T>[]
  /** Max visible items (auto-capped to terminal height). Default: 10. */
  visibleCount?: number
  /** Optional preview renderer. Returns lines of text for focused item. */
  renderPreview?: (item: PickerItem<T>) => string[]
  /** Placeholder text for empty search box. */
  placeholder?: string
  /** Initial search query. */
  initialQuery?: string
  /** Stream for output. Default: stderr. */
  stream?: NodeJS.WriteStream
  /** Readline interface to pause/resume around picker (prevents input collision). */
  readline?: import('readline').Interface
}

export interface PickerResult<T = unknown> {
  /** Selected item, or null if cancelled. */
  item: PickerItem<T> | null
  /** Whether the user cancelled (Esc). */
  cancelled: boolean
}

const PICKER_ACTIVE_PROP = '__owlPickerActive'
const PICKER_IGNORE_LINES_UNTIL_PROP = '__owlIgnoreLinesUntil'

export function resetReadlineInputState(
  rl?: import('readline').Interface,
): void {
  if (!rl) return
  const rlAny = rl as any
  rlAny.line = ''
  rlAny.cursor = 0
}

export function isReadlinePickerSettling(
  rl?: import('readline').Interface,
): boolean {
  if (!rl) return false
  const rlAny = rl as any
  return rlAny[PICKER_ACTIVE_PROP] === true
    || (typeof rlAny[PICKER_IGNORE_LINES_UNTIL_PROP] === 'number'
      && Date.now() < rlAny[PICKER_IGNORE_LINES_UNTIL_PROP])
}

function setReadlinePickerState(
  rl: import('readline').Interface | undefined,
  active: boolean,
  ignoreForMs = 0,
): void {
  if (!rl) return
  const rlAny = rl as any
  rlAny[PICKER_ACTIVE_PROP] = active
  rlAny[PICKER_IGNORE_LINES_UNTIL_PROP] = ignoreForMs > 0 ? Date.now() + ignoreForMs : 0
}

// ─── Fuzzy match ──────────────────────────────────────────────

/**
 * Simple fuzzy match: every character in the query must appear
 * in order within the target string (case-insensitive).
 * Returns match score (lower = tighter match) or -1 for no match.
 */
export function fuzzyMatch(query: string, target: string): number {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let qi = 0
  let score = 0
  let lastMatchPos = -1

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      // Bonus for consecutive matches
      score += ti - (lastMatchPos + 1)
      lastMatchPos = ti
      qi++
    }
  }

  return qi === q.length ? score : -1
}

/**
 * Highlight matched characters in a label.
 * Returns the label with matched chars in theme accent color.
 */
export function highlightMatch(label: string, query: string): string {
  if (!query) return label
  const q = query.toLowerCase()
  const plain = stripAnsi(label)
  const t = plain.toLowerCase()
  let qi = 0
  let result = ''
  const accent = themeColor('info')

  for (let i = 0; i < plain.length; i++) {
    if (qi < q.length && t[i] === q[qi]) {
      result += `${accent}${sgr.bold}${plain[i]}${sgr.reset}`
      qi++
    } else {
      result += plain[i]
    }
  }

  return result
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

// ─── Rendering helpers ────────────────────────────────────────

/** Chrome rows: title(2) + searchbox(3) + blank + matchcount + blank + hints(1) = 8, +2 for 3-line box */
const CHROME_ROWS = 10

function renderSearchBox(query: string, placeholder: string): string {
  const border = themeColor('border')
  const cols = Math.min(process.stdout.columns ?? 80, 60)

  const content = query || `${dim(placeholder)}`
  const inner = truncate(content, cols - 4)

  return [
    `${border}╭${'─'.repeat(cols - 2)}╮${sgr.reset}`,
    `${border}│${sgr.reset} ${inner}${''.padEnd(Math.max(0, cols - 3 - visibleWidth(inner)))}${border}│${sgr.reset}`,
    `${border}╰${'─'.repeat(cols - 2)}╯${sgr.reset}`,
  ].join('\n')
}

function renderListItem<T>(
  item: PickerItem<T>,
  isFocused: boolean,
  query: string,
): string {
  const prefix = isFocused
    ? `${themeColor('info')}❯ ${sgr.reset}`
    : '  '

  const label = isFocused
    ? `${themeColor('text')}${sgr.bold}${highlightMatch(item.label, query)}${sgr.reset}`
    : highlightMatch(item.label, query)

  const desc = item.description
    ? ` ${dim(truncate(item.description, 40))}`
    : ''

  return `${prefix}${label}${desc}`
}

function renderHints(): string {
  return formatKeyHint([
    { key: '↑/↓', action: 'navigate' },
    { key: 'Enter', action: 'select' },
    { key: 'Esc', action: 'cancel' },
  ])
}

// ─── Main picker ──────────────────────────────────────────────

/**
 * Isolation hook: any host (e.g. the Ink REPL) that needs to yield the
 * terminal to an imperative picker registers enter/exit callbacks here.
 * showPicker invokes them around its lifecycle — no per-command whitelist
 * required; every call to showPicker gets isolation automatically.
 *
 * A null value means "no host registered" (e.g. running under a test harness
 * or CI without a live TTY); showPicker then operates without isolation.
 */
export interface PickerIsolationHooks {
  enter: () => void
  exit: () => void
}

let isolationHooks: PickerIsolationHooks | null = null

export function registerPickerIsolation(hooks: PickerIsolationHooks | null): void {
  isolationHooks = hooks
}

/** Test helper — inspect / reset the currently registered hooks. */
export function __getPickerIsolationForTests(): PickerIsolationHooks | null {
  return isolationHooks
}

/**
 * Show an interactive fuzzy picker in the terminal.
 *
 * Takes over stdin/stdout for the duration. Returns a promise
 * that resolves when the user selects or cancels.
 */
export async function showPicker<T>(
  opts: PickerOptions<T>,
): Promise<PickerResult<T>> {
  const stream = opts.stream ?? process.stdout
  const items = opts.items
  const placeholder = opts.placeholder ?? 'Type to search…'
  const maxVisible = opts.visibleCount ?? 10

  // Capability-driven isolation: whoever owns the frame (Ink REPL) registered
  // alt-screen enter/exit via registerPickerIsolation. Calling showPicker
  // from ANYWHERE now gets clean terrain automatically — no slash-command
  // whitelist to maintain, no risk of a new picker path slipping through.
  isolationHooks?.enter()

  // Pause readline to prevent input collision during picker
  setReadlinePickerState(opts.readline, true)
  resetReadlineInputState(opts.readline)
  if (opts.readline) opts.readline.pause()

  // Cap visible rows to terminal
  const rows = process.stdout.rows ?? 24
  const visibleCount = Math.max(3, Math.min(maxVisible, rows - CHROME_ROWS))

  let query = opts.initialQuery ?? ''
  let focusIndex = 0
  let scrollOffset = 0
  let filtered = filterItems(items, query)

  function filterItems(
    source: PickerItem<T>[],
    q: string,
  ): PickerItem<T>[] {
    if (!q) return [...source]
    return source
      .map((item) => ({
        item,
        score: fuzzyMatch(q, stripAnsi(item.label) + (item.description ?? '')),
      }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score)
      .map((x) => x.item)
  }

  function clampFocus(): void {
    if (filtered.length === 0) {
      focusIndex = 0
    } else {
      focusIndex = Math.max(0, Math.min(focusIndex, filtered.length - 1))
    }
    // Adjust scroll
    if (focusIndex < scrollOffset) {
      scrollOffset = focusIndex
    } else if (focusIndex >= scrollOffset + visibleCount) {
      scrollOffset = focusIndex - visibleCount + 1
    }
  }

  let lastPaintedLines = 0

  function paint(): void {
    const lines: string[] = []

    // Title
    if (opts.title) {
      lines.push(`${themeColor('owl')}${sgr.bold}${opts.title}${sgr.reset}`)
      lines.push('')
    }

    // Search box (renderSearchBox returns 3 lines joined by \n — spread them)
    lines.push(...renderSearchBox(query, placeholder).split('\n'))
    lines.push('')

    // Match count
    const matchText = query
      ? dim(`${filtered.length}/${items.length} matches`)
      : dim(`${items.length} items`)
    lines.push(matchText)

    // List items
    const visible = filtered.slice(scrollOffset, scrollOffset + visibleCount)
    for (let i = 0; i < visible.length; i++) {
      const idx = scrollOffset + i
      lines.push(renderListItem(visible[i]!, idx === focusIndex, query))
    }

    // Pad if fewer items than visibleCount
    for (let i = visible.length; i < visibleCount; i++) {
      lines.push('')
    }

    // Scroll indicator
    if (filtered.length > visibleCount) {
      const pct = Math.round(
        ((scrollOffset + visibleCount / 2) / filtered.length) * 100,
      )
      lines.push(dim(`  ▾ ${pct}%`))
    }

    // Preview pane
    if (opts.renderPreview && filtered[focusIndex]) {
      const preview = opts.renderPreview(filtered[focusIndex]!)
      lines.push('')
      lines.push(dim('─'.repeat(Math.min(process.stdout.columns ?? 60, 60))))
      for (const pl of preview.slice(0, 5)) {
        lines.push(`  ${pl}`)
      }
    }

    // Hints
    lines.push('')
    lines.push(renderHints())

    // Move cursor up to overwrite previous paint.
    // Cursor is at line `top + lastPaintedLines` after each paint cycle.
    // Move up exactly `lastPaintedLines` to return to `top`.
    const moveUp = Math.max(lastPaintedLines, lines.length)
    if (moveUp > 0) {
      stream.write(`\x1b[${moveUp}A`)
    }

    for (const line of lines) {
      stream.write(`\x1b[K${line}\n`)
    }

    // Clear any leftover lines from previous longer paint
    for (let i = lines.length; i < lastPaintedLines; i++) {
      stream.write('\x1b[K\n')
    }
    stream.write('\x1b[K')

    lastPaintedLines = Math.max(lines.length, lastPaintedLines)
  }

  return new Promise<PickerResult<T>>((resolve) => {
    // Reserve space — calculate exact line count to match first paint.
    // Write exactly `reserveLines` newlines so cursor ends at `top + reserveLines`.
    // First paint() will move up `reserveLines` to reach `top`.
    const reserveLines =
      (opts.title ? 2 : 0) +  // title + blank
      4 +                      // search box (3 border lines) + blank
      1 +                      // match count
      visibleCount +           // item slots
      (filtered.length > visibleCount ? 1 : 0) + // scroll indicator
      2                        // blank + hints
    lastPaintedLines = reserveLines
    stream.write('\n'.repeat(reserveLines))

    // Initial paint
    paint()

    // Set raw mode to capture keystrokes
    const wasRaw = process.stdin.isRaw
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
    }
    process.stdin.resume()

    let escBuffer = ''
    let escTimer: ReturnType<typeof setTimeout> | null = null

    function cleanup(): void {
      process.stdin.removeListener('data', onData)
      if (process.stdin.isTTY && wasRaw !== undefined) {
        process.stdin.setRawMode(wasRaw ?? false)
      }
      if (escTimer) clearTimeout(escTimer)
      setReadlinePickerState(opts.readline, false, 250)
      resetReadlineInputState(opts.readline)
      // Erase the picker area: move up, clear each line, move down to final position
      const totalLines = lastPaintedLines
      if (totalLines > 0) {
        stream.write(`\x1b[${totalLines}A`)
        for (let i = 0; i < totalLines; i++) {
          stream.write('\x1b[K\n')
        }
        stream.write('\x1b[K')
        // Move back up to where user's next prompt should be
        stream.write(`\x1b[${totalLines}A`)
      }
      // Resume readline after picker is done and the screen is clean.
      if (opts.readline) opts.readline.resume()
      // Hand the frame back to the host. Runs LAST so the picker's cursor
      // cleanup above has fully drained into the alt screen before Ink
      // repaints main.
      isolationHooks?.exit()
    }

    function onData(data: Buffer): void {
      const str = data.toString('utf8')

      // Handle escape sequences
      for (let i = 0; i < str.length; i++) {
        const ch = str[i]!
        const code = str.charCodeAt(i)

        if (escBuffer.length > 0) {
          escBuffer += ch
          if (escBuffer.length >= 3) {
            handleEscapeSequence(escBuffer)
            escBuffer = ''
            if (escTimer) {
              clearTimeout(escTimer)
              escTimer = null
            }
          }
          continue
        }

        if (code === 0x1b) {
          // Start of escape sequence or standalone Esc
          escBuffer = ch
          escTimer = setTimeout(() => {
            // Standalone Esc — cancel
            cleanup()
            resolve({ item: null, cancelled: true })
          }, 50)
          continue
        }

        if (code === 0x0d || code === 0x0a) {
          // Enter — select
          cleanup()
          const selected = filtered[focusIndex] ?? null
          resolve({ item: selected, cancelled: false })
          return
        }

        if (code === 0x03) {
          // Ctrl+C — cancel
          cleanup()
          resolve({ item: null, cancelled: true })
          return
        }

        if (code === 0x7f || code === 0x08) {
          // Backspace
          if (query.length > 0) {
            query = query.slice(0, -1)
            filtered = filterItems(items, query)
            focusIndex = 0
            scrollOffset = 0
            clampFocus()
            paint()
          }
          continue
        }

        if (code === 0x15) {
          // Ctrl+U — clear query
          query = ''
          filtered = filterItems(items, query)
          focusIndex = 0
          scrollOffset = 0
          paint()
          continue
        }

        // Regular character — add to query
        if (code >= 0x20 && code < 0x7f) {
          query += ch
          filtered = filterItems(items, query)
          focusIndex = 0
          scrollOffset = 0
          clampFocus()
          paint()
        }
      }
    }

    function handleEscapeSequence(seq: string): void {
      if (escTimer) {
        clearTimeout(escTimer)
        escTimer = null
      }

      if (seq === '\x1b[A' || seq === '\x1bOA') {
        // Up arrow
        if (focusIndex > 0) {
          focusIndex--
          clampFocus()
          paint()
        }
      } else if (seq === '\x1b[B' || seq === '\x1bOB') {
        // Down arrow
        if (focusIndex < filtered.length - 1) {
          focusIndex++
          clampFocus()
          paint()
        }
      } else if (seq === '\x1b[5') {
        // Page Up (partial, need ~)
      } else if (seq === '\x1b[6') {
        // Page Down (partial, need ~)
      }
    }

    process.stdin.on('data', onData)
  })
}
