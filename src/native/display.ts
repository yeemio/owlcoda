/**
 * OwlCoda Native Display Formatter
 *
 * Delegates to the TUI engine (src/native/tui/) for all rendering.
 * This module preserves the legacy API surface for backward compatibility.
 */

import {
  sgr, dim as tuiDim, bold as tuiBold, themeColor,
  stripAnsi as tuiStripAnsi,
  Spinner as TuiSpinner,
  formatToolUseHeader,
  formatToolResult,
  formatErrorMessage,
  formatTokenUsage,
  formatStopReason as tuiStopReason,
  formatIterations as tuiIterations,
  renderWelcome,
  type WelcomeOptions,
} from './tui/index.js'

// ─── Legacy ANSI helpers (kept for existing imports) ──────────

/** ANSI color helpers — thin wrapper over TUI sgr. */
export const ansi = {
  reset: sgr.reset,
  bold: sgr.bold,
  dim: sgr.dim,
  italic: sgr.italic,
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const

// ─── Tool display (delegates to TUI message.ts) ──────────────

/** Format a tool start message. */
export function formatToolStart(name: string, input: Record<string, unknown>): string {
  return formatToolUseHeader(name, input)
}

/** Format a tool end message. */
export function formatToolEnd(name: string, result: string, isError: boolean, durationMs: number): string {
  return formatToolResult(name, result, isError, durationMs)
}

/** Format an error message. */
export function formatError(error: string): string {
  return formatErrorMessage(error)
}

/** Format iteration count. */
export function formatIterations(count: number): string {
  return tuiIterations(count)
}

/** Truncate long tool output for display. */
export function truncateOutput(text: string, maxLines = 20): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text

  const head = lines.slice(0, maxLines / 2)
  const tail = lines.slice(-maxLines / 2)
  const omitted = lines.length - maxLines
  return [
    ...head,
    `${sgr.dim}... (${omitted} lines omitted) ...${sgr.reset}`,
    ...tail,
  ].join('\n')
}

// ─── Welcome banner (delegates to TUI welcome.ts) ────────────

export interface BannerOptions {
  version: string
  model: string
  mode: string
  sessionId: string
  cwd: string
  columns?: number
  recentSessions?: { id: string; title?: string; turns: number; date: string }[]
  /** Override tips shown in the right column. */
  tips?: string[]
  /** Optional welcome animation frame hint. */
  logoFrame?: import('./tui/welcome.js').LogoFrame
  /** True on first launch — no prior sessions. Switches greeting copy. */
  isFirstRun?: boolean
}

/** Render a box-drawn welcome banner using the TUI engine. */
export function formatBanner(opts: BannerOptions): string {
  return renderWelcome({
    version: opts.version,
    model: opts.model,
    mode: opts.mode,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    columns: opts.columns,
    recentSessions: opts.recentSessions,
    logoFrame: opts.logoFrame,
    isFirstRun: opts.isFirstRun,
    tips: opts.tips ?? [
      '/help for commands',
      '/model to switch',
      '/editor for multi-line',
      '/quit to exit',
    ],
  })
}

// ─── Response metadata (delegates to TUI message.ts) ─────────

/** Format token usage line (shown after each response). */
export function formatUsage(inputTokens: number, outputTokens: number): string {
  return formatTokenUsage(inputTokens, outputTokens)
}

/** Format stop reason (shown after truncated/unusual stops). */
export function formatStopReason(reason: string | null): string {
  return tuiStopReason(reason)
}

// ─── Spinner (delegates to TUI spinner.ts) ────────────────────

/**
 * Spinner for indicating activity.
 * Now backed by the TUI engine's enhanced spinner.
 */
export class Spinner {
  private inner = new TuiSpinner({ message: '', style: 'dots' })

  start(message = ''): void {
    this.inner.start(message)
  }

  stop(clearLine = true): void {
    this.inner.stop(clearLine)
  }
}
