/**
 * OwlCoda — Interactive History Search (Ctrl+R)
 *
 * Reverse incremental search through readline history.
 * Architecture: intercepts raw keypress events on stdin,
 * renders inline search UI, restores readline on exit.
 *
 * Upstream uses a React hook (useHistorySearch) with Ink TextInput.
 * We use direct ANSI rendering with raw stdin mode — same behavior,
 * completely different implementation.
 */

import type * as readline from 'node:readline'
import { sgr, dim, themeColor } from './colors.js'
import { stripAnsi } from './colors.js'

export interface HistorySearchState {
  active: boolean
  query: string
  matchIndex: number
  match: string | null
  failed: boolean
}

/**
 * HistorySearch — attaches to a readline interface to provide Ctrl+R search.
 *
 * Usage:
 *   const hs = new HistorySearch(rl)
 *   hs.install()  // hooks keypress events
 *   // ... when rl is closed:
 *   hs.uninstall()
 */
export class HistorySearch {
  private rl: readline.Interface
  private state: HistorySearchState = {
    active: false,
    query: '',
    matchIndex: -1,
    match: null,
    failed: false,
  }
  private keypressHandler: ((str: string | undefined, key: KeyInfo) => void) | null = null
  private stashedLine: string = ''
  private stashedCursor: number = 0

  constructor(rl: readline.Interface) {
    this.rl = rl
  }

  /** Hook into stdin keypress events. */
  install(): void {
    if (this.keypressHandler) return

    // Ensure keypress events are emitted
    const stdin = process.stdin
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
      // readline already sets raw mode, but we need keypress events
      // Node's readline module already calls emitKeypressEvents internally
    }

    this.keypressHandler = (str, key) => {
      if (!key) return

      // Ctrl+R: activate or search deeper
      if (key.ctrl && key.name === 'r') {
        if (!this.state.active) {
          this.activate()
        } else {
          // Search further back in history
          this.searchNext()
        }
        return
      }

      // If not active, ignore
      if (!this.state.active) return

      // Handle keys while search is active
      if (key.name === 'escape' || (key.ctrl && key.name === 'g')) {
        // Cancel search — restore original line
        this.cancel()
      } else if (key.name === 'return') {
        // Accept match and submit
        this.accept(true)
      } else if (key.name === 'backspace') {
        // Remove last char from query
        if (this.state.query.length > 0) {
          this.state.query = this.state.query.slice(0, -1)
          this.search()
          this.render()
        } else {
          this.cancel()
        }
      } else if (key.ctrl && (key.name === 'a' || key.name === 'e' || key.name === 'f' || key.name === 'b')) {
        // Navigation key — accept match and let readline handle it
        this.accept(false)
      } else if (str && !key.ctrl && !key.meta && str.length === 1 && str.charCodeAt(0) >= 32) {
        // Printable character — add to query
        this.state.query += str
        this.search()
        this.render()
      }
    }

    process.stdin.on('keypress', this.keypressHandler)
  }

  /** Remove keypress hook. */
  uninstall(): void {
    if (this.keypressHandler) {
      process.stdin.removeListener('keypress', this.keypressHandler)
      this.keypressHandler = null
    }
  }

  /** Get current history entries from readline (undocumented but stable API). */
  private getHistory(): string[] {
    // readline.Interface has an internal `history` array
    const rlAny = this.rl as any
    return rlAny.history ?? []
  }

  /** Activate search mode. */
  private activate(): void {
    // Stash current input
    const rlAny = this.rl as any
    this.stashedLine = rlAny.line ?? ''
    this.stashedCursor = rlAny.cursor ?? 0

    this.state = {
      active: true,
      query: '',
      matchIndex: -1,
      match: null,
      failed: false,
    }
    this.render()
  }

  /** Search history for current query. */
  private search(): void {
    const history = this.getHistory()
    const q = this.state.query.toLowerCase()
    if (!q) {
      this.state.match = null
      this.state.matchIndex = -1
      this.state.failed = false
      return
    }

    // Search from matchIndex+1 onwards (deeper into history)
    const startIdx = 0
    for (let i = startIdx; i < history.length; i++) {
      if (history[i]!.toLowerCase().includes(q)) {
        this.state.match = history[i]!
        this.state.matchIndex = i
        this.state.failed = false
        return
      }
    }

    this.state.failed = true
    this.state.match = null
  }

  /** Search further back from current match. */
  private searchNext(): void {
    const history = this.getHistory()
    const q = this.state.query.toLowerCase()
    if (!q) return

    const startIdx = this.state.matchIndex + 1
    for (let i = startIdx; i < history.length; i++) {
      if (history[i]!.toLowerCase().includes(q)) {
        this.state.match = history[i]!
        this.state.matchIndex = i
        this.state.failed = false
        this.render()
        return
      }
    }

    this.state.failed = true
    this.render()
  }

  /** Cancel search — restore stashed line. */
  private cancel(): void {
    this.state.active = false
    this.clearSearchLine()
    // Restore stashed input
    const rlAny = this.rl as any
    rlAny.line = this.stashedLine
    rlAny.cursor = this.stashedCursor
    this.rl.prompt(true)
  }

  /** Accept current match — put it in the readline buffer. */
  private accept(submit: boolean): void {
    const match = this.state.match ?? this.stashedLine
    this.state.active = false
    this.clearSearchLine()

    const rlAny = this.rl as any
    rlAny.line = match
    rlAny.cursor = match.length

    if (submit) {
      // Write a newline to submit
      process.stdout.write('\n')
      // Emit the line event
      this.rl.emit('line', match)
    } else {
      // Just put the match in the buffer for further editing
      this.rl.prompt(true)
    }
  }

  /** Render the search prompt inline. */
  private render(): void {
    const label = this.state.failed
      ? `${themeColor('error')}failing search:${sgr.reset}`
      : `${dim('search prompts:')}` 

    const query = this.state.query
    const match = this.state.match ?? ''

    // Clear current line and show search prompt
    process.stdout.write(`\r\x1b[K`)
    if (query) {
      // Highlight the match portion
      const matchDisplay = match ? this.highlightMatch(match, query) : dim('(no match)')
      process.stdout.write(`${label} ${query}  ${dim('→')} ${matchDisplay}`)
    } else {
      process.stdout.write(`${label} `)
    }
  }

  /** Highlight the query within a match string. */
  private highlightMatch(text: string, query: string): string {
    const idx = text.toLowerCase().indexOf(query.toLowerCase())
    if (idx < 0) return dim(text)
    const before = text.slice(0, idx)
    const matched = text.slice(idx, idx + query.length)
    const after = text.slice(idx + query.length)
    return `${dim(before)}${themeColor('success')}${matched}${sgr.reset}${dim(after)}`
  }

  /** Clear the search line. */
  private clearSearchLine(): void {
    process.stdout.write(`\r\x1b[K`)
  }

  /** Check if search is currently active (used by REPL to skip line processing). */
  get isActive(): boolean {
    return this.state.active
  }
}

/** Minimal key info from Node.js keypress events. */
interface KeyInfo {
  name?: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  sequence?: string
}
