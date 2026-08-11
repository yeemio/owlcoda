/**
 * Transcript chrome vocabulary — single source of truth for how the REPL
 * presents information classes (spec: docs/superpowers/specs/
 * 2026-06-11-transcript-chrome-spec-design.md).
 *
 * S1 scope: the human display of tool results is decoupled from the model
 * payload. Bash's `[stdout]/[stderr]/[exit code: N]` protocol stays intact
 * for the model; humans get clean body lines plus a constant-shape fold
 * line. Presentation only — no markdown parsing, no repaint involvement.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dim, sgr, themeColor, visibleWidth } from './colors.js'
import wrapText from '../../ink/wrap-text.js'
import { formatTokenCompact } from '../../model-capabilities.js'

export type RenderFaultKind = 'uncaught' | 'caught' | 'recoverable'

export type RenderFaultRecovery =
  | 'none'
  | 'repaint_scheduled'
  | 'repaint_suppressed_limit'
  | 'repaint_failed'
  | 'terminal_cleanup'
  | 'already_isolated'

export type RenderFaultRendererState = 'healthy' | 'isolated'

export type RenderFaultContext = {
  renderSequence: number
  frameSequence: number
  phase?: string
}

export type SerializedRenderError = {
  name: string
  message: string
  stack: string | null
}

export type RenderFaultIncident = {
  schemaVersion: 1
  at: string
  faultKind: RenderFaultKind
  sequence: number
  frame: RenderFaultContext
  componentStack: string | null
  error: SerializedRenderError
  rendererState: RenderFaultRendererState
  recovery: RenderFaultRecovery
  incidentPath: string | null
}

export type RenderFaultAdapterOptions = {
  getContext: () => RenderFaultContext
  writeIncident: (incident: RenderFaultIncident) => string | null
  isolateFrameProducer: () => void
  cleanupTerminal: () => void
  requestRecovery: () => void
  notify: (message: string) => void
}

export type RenderFaultAdapter = {
  onUncaughtError: (error: unknown, errorInfo: unknown) => void
  onCaughtError: (error: unknown, errorInfo: unknown) => void
  onRecoverableError: (error: unknown, errorInfo: unknown) => void
  getState: () => {
    rendererState: RenderFaultRendererState
    recoverableRecoveryCount: number
    uncaughtHandled: boolean
  }
}

const UNAVAILABLE = '[unavailable]'

function safeString(value: unknown): string {
  try {
    return String(value)
  } catch {
    return UNAVAILABLE
  }
}

function safeProperty(value: object, key: string): string {
  try {
    return safeString((value as Record<string, unknown>)[key])
  } catch {
    return UNAVAILABLE
  }
}

export function serializeRenderError(error: unknown): SerializedRenderError {
  try {
    if (error instanceof Error) {
      const name = safeProperty(error, 'name')
      const message = safeProperty(error, 'message')
      const stack = safeProperty(error, 'stack')
      return {
        name: name === UNAVAILABLE ? 'UnknownError' : name,
        message,
        stack: stack === UNAVAILABLE ? null : stack,
      }
    }
    const message = safeString(error)
    return {
      name: message === UNAVAILABLE ? 'UnknownError' : 'NonError',
      message,
      stack: null,
    }
  } catch {
    return {
      name: 'UnknownError',
      message: UNAVAILABLE,
      stack: null,
    }
  }
}

function safeContext(getContext: () => RenderFaultContext): RenderFaultContext {
  try {
    const context = getContext()
    return {
      renderSequence: Number.isFinite(context.renderSequence) ? context.renderSequence : -1,
      frameSequence: Number.isFinite(context.frameSequence) ? context.frameSequence : -1,
      ...(context.phase ? { phase: safeString(context.phase) } : {}),
    }
  } catch {
    return { renderSequence: -1, frameSequence: -1, phase: 'unknown' }
  }
}

function safeComponentStack(errorInfo: unknown): string | null {
  if (!errorInfo || typeof errorInfo !== 'object') return null
  const stack = safeProperty(errorInfo, 'componentStack')
  return stack === UNAVAILABLE ? null : stack || null
}

function safeInvoke(fn: () => void): void {
  try {
    fn()
  } catch {
    // Fault handling must never recurse into the reconciler or expose the
    // original error while reporting a secondary handler failure.
  }
}

function renderFaultMessage(incident: RenderFaultIncident): string {
  const path = incident.incidentPath ? `; incident: ${incident.incidentPath}` : ''
  switch (incident.faultKind) {
    case 'uncaught':
      return `OwlCoda TUI render fault isolated the frame writer; terminal cleanup was attempted${path}. restart OwlCoda to restore rendering.`
    case 'caught':
      return `OwlCoda TUI render fault was caught by a React boundary; inspect the incident before continuing${path}.`
    case 'recoverable':
      return incident.recovery === 'repaint_scheduled'
        ? `OwlCoda TUI render fault recovered with one controlled repaint${path}.`
        : `OwlCoda TUI render fault recovery limit reached; no further repaint will be attempted${path}.`
  }
}

export function createRenderFaultAdapter(options: RenderFaultAdapterOptions): RenderFaultAdapter {
  let sequence = 0
  let rendererState: RenderFaultRendererState = 'healthy'
  let recoverableRecoveryCount = 0
  let uncaughtHandled = false

  const handle = (faultKind: RenderFaultKind, error: unknown, errorInfo: unknown): void => {
    const incident: RenderFaultIncident = {
      schemaVersion: 1,
      at: new Date().toISOString(),
      faultKind,
      sequence: ++sequence,
      frame: safeContext(options.getContext),
      componentStack: safeComponentStack(errorInfo),
      error: serializeRenderError(error),
      rendererState,
      recovery: 'none',
      incidentPath: null,
    }

    if (faultKind === 'uncaught') {
      if (uncaughtHandled) {
        incident.rendererState = 'isolated'
        incident.recovery = 'already_isolated'
      } else {
        uncaughtHandled = true
        rendererState = 'isolated'
        incident.rendererState = rendererState
        incident.recovery = 'terminal_cleanup'
        safeInvoke(options.isolateFrameProducer)
        safeInvoke(options.cleanupTerminal)
      }
    } else if (faultKind === 'recoverable') {
      if (recoverableRecoveryCount === 0 && rendererState === 'healthy') {
        recoverableRecoveryCount = 1
        incident.recovery = 'repaint_scheduled'
        try {
          options.requestRecovery()
        } catch {
          incident.recovery = 'repaint_failed'
        }
      } else {
        incident.recovery = 'repaint_suppressed_limit'
      }
    }

    try {
      const path = options.writeIncident(incident)
      incident.incidentPath = typeof path === 'string' ? path : null
    } catch {
      incident.incidentPath = null
    }

    safeInvoke(() => options.notify(renderFaultMessage(incident)))
  }

  return {
    onUncaughtError: (error, errorInfo) => handle('uncaught', error, errorInfo),
    onCaughtError: (error, errorInfo) => handle('caught', error, errorInfo),
    onRecoverableError: (error, errorInfo) => handle('recoverable', error, errorInfo),
    getState: () => ({ rendererState, recoverableRecoveryCount, uncaughtHandled }),
  }
}

// ─── Narration (what the model says) ─────────────────────────────────────
// S2: narration gets its own gutter so ⎿ can go back to meaning "output of
// the action above" exclusively. The chrome layer wraps to the terminal
// width with a hanging indent — long CJK lines no longer fall to col 0 when
// the terminal hard-wraps them.

const NARRATION_GLYPH = '●'
const NARRATION_INDENT = '  '

export interface NarrationOptions {
  /** true when this is the first rendered block of a narration segment */
  firstBlock: boolean
  columns: number
}

export function renderNarration(rendered: string, opts: NarrationOptions): string {
  const columns = Math.max(8, opts.columns)
  const contentWidth = Math.max(4, columns - NARRATION_INDENT.length)
  const logicalLines = rendered.split('\n')
  const out: string[] = []
  let first = opts.firstBlock

  logicalLines.forEach((logicalLine, index) => {
    const isTrailingEmpty = index === logicalLines.length - 1 && logicalLine === ''
    if (isTrailingEmpty) {
      out.push('')
      return
    }
    if (logicalLine === '') {
      // Blank separator rows stay byte-empty — selection-first: no
      // invisible indent padding in copied text.
      out.push('')
      return
    }
    const wrapped = wrapText(logicalLine, contentWidth, 'wrap').split('\n')
    for (const visual of wrapped) {
      if (first) {
        first = false
        out.push(`${themeColor('owl')}${NARRATION_GLYPH}${sgr.reset} ${visual}`)
      } else {
        out.push(`${NARRATION_INDENT}${visual}`)
      }
    }
  })

  return out.join('\n')
}

// ─── Result body collapse budgets ────────────────────────────────────────
// ok results show the head (the interesting part of a listing/log) and err
// results show the tail (errors accumulate at the end of output).
export const RESULT_HEAD_LINES: Record<string, number> = {
  bash: 5,
}
export const RESULT_HEAD_DEFAULT = 3
export const RESULT_ERR_TAIL_LINES = 10

export function resultBodyBudget(canonicalName: string, isError: boolean): number {
  if (isError) return RESULT_ERR_TAIL_LINES
  return RESULT_HEAD_LINES[canonicalName] ?? RESULT_HEAD_DEFAULT
}

// ─── Bash payload → display payload ──────────────────────────────────────

export interface BashDisplayPayload {
  /** stdout lines followed by stderr lines, protocol labels stripped */
  lines: string[]
  exitCode: number | null
  killed: boolean
}

const EXIT_CODE_RE = /^\[exit code: (-?\d+)\]$/m
const KILLED_RE = /^\[killed\] [^\n]*$/m

/**
 * Parse the model-facing bash tool_result protocol (bash.ts
 * formatBashOutput: `[stdout]\n…`, `[stderr]\n…`, `[killed] …`,
 * `[exit code: N]`) into a display payload. Returns null when the text
 * does not carry the protocol trailer — caller falls back to raw output.
 */
export function parseBashPayload(output: string): BashDisplayPayload | null {
  const exitMatch = output.match(EXIT_CODE_RE)
  if (!exitMatch) return null

  const killed = KILLED_RE.test(output)
  let body = output
    .replace(EXIT_CODE_RE, '')
    .replace(KILLED_RE, '')

  const lines: string[] = []
  let inSection = false
  for (const line of body.split('\n')) {
    if (line === '[stdout]' || line === '[stderr]') {
      inSection = true
      continue
    }
    if (!inSection) continue
    lines.push(line)
  }
  // The protocol joins sections with blank lines and the trailer leaves a
  // trailing gap — trim blank edges without touching interior blanks.
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift()
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop()

  return {
    lines,
    exitCode: Number.parseInt(exitMatch[1]!, 10),
    killed,
  }
}

// ─── Folding ─────────────────────────────────────────────────────────────

export interface CollapseResult {
  shown: string[]
  hidden: number
  fromTail: boolean
}

export function collapseResultBody(
  lines: string[],
  opts: { isError: boolean; budget: number },
): CollapseResult {
  const budget = Math.max(1, opts.budget)
  if (lines.length <= budget) {
    return { shown: lines, hidden: 0, fromTail: false }
  }
  if (opts.isError) {
    return { shown: lines.slice(-budget), hidden: lines.length - budget, fromTail: true }
  }
  return { shown: lines.slice(0, budget), hidden: lines.length - budget, fromTail: false }
}

/**
 * Constant-shape fold line: `… +N lines · meta`. The shape is locked by
 * regression tests — every collapsed body in the transcript folds the same
 * way, so the eye learns it once.
 */
export function foldLine(hidden: number, meta?: string): string {
  const base = `… +${hidden} lines`
  return dim(meta ? `${base} · ${meta}` : base)
}

// ─── Notices, progress, key-value layout (S3) ────────────────────────────

export type NoticeKind = 'info' | 'success' | 'warning'

const NOTICE_GLYPHS: Record<NoticeKind, string> = {
  info: 'ⓘ',
  success: '✓',
  warning: '⚠',
}

/** One-line system notice: quiet, glyph-colored, never multi-line. */
export function renderNotice(text: string, kind: NoticeKind = 'info'): string {
  const oneLine = text.replace(/\s*\n\s*/g, ' — ').trim()
  const color = kind === 'success'
    ? themeColor('success')
    : kind === 'warning'
      ? themeColor('warning')
      : themeColor('textSubtle')
  return `${color}${NOTICE_GLYPHS[kind]}${sgr.reset} ${dim(oneLine)}`
}

export interface TurnFooterOptions {
  iterations: number
  inputTokens: number
  outputTokens: number
  elapsedSeconds: number
}

/**
 * Per-turn progress footer — ONE quiet line replacing the old stacked
 * "(N iterations)" + "[X in / Y out — Z total] · 12.3s" pair:
 *
 *   ── 15 it · 7.6k in / 2.8k out · 96.1s
 */
export function renderTurnFooter(opts: TurnFooterOptions): string {
  const hasTokens = opts.inputTokens > 0 || opts.outputTokens > 0
  if (!hasTokens && opts.iterations <= 1) return ''
  const parts: string[] = []
  if (opts.iterations > 1) parts.push(`${opts.iterations} it`)
  if (hasTokens) {
    parts.push(`${formatTokenCompact(opts.inputTokens)} in / ${formatTokenCompact(opts.outputTokens)} out`)
  }
  parts.push(`${opts.elapsedSeconds.toFixed(1)}s`)
  return `${themeColor('textSubtle')}── ${parts.join(' · ')}${sgr.reset}`
}

/**
 * Aligned key-value block for slash-command panels (/status, /cost…).
 * Key column width is measured in display cells, so CJK keys align too.
 */
export function renderKeyValue(pairs: ReadonlyArray<readonly [string, string]>): string {
  const keyWidth = pairs.reduce((w, [k]) => Math.max(w, visibleWidth(k)), 0)
  return pairs
    .map(([k, v]) => `${dim(k)}${' '.repeat(keyWidth - visibleWidth(k) + 2)}${v}`)
    .join('\n')
}

/** Styled single-line section header for grouped slash output (/help). */
export function renderSection(title: string): string {
  return `${sgr.bold}${themeColor('owl')}${title.replace(/\n/g, ' ')}${sgr.reset}`
}

// ─── Render incident capture ─────────────────────────────────────────────
// 2026-06-12: long CJK turns rendered corrupted in live sessions but every
// layer replays clean from the saved text — the failing input only exists
// at render time. Keep a bounded ring of the raw chunks fed to
// mdRenderer.push(); when the render path throws (the safeRender fallback
// otherwise prints RAW markdown silently), persist ring + error to
// <home>/render-incidents/ so the next occurrence pins the layer.

const RAW_MD_RING_LIMIT = 256
const rawMdRing: string[] = []
let lastIncidentDumpMs = 0
const INCIDENT_THROTTLE_MS = 60_000

export type RenderIncidentMetadata = {
  faultKind?: RenderFaultKind
  sequence?: number
  frame?: RenderFaultContext
  componentStack?: string | null
  rendererState?: RenderFaultRendererState
  recovery?: RenderFaultRecovery
  errorDetails?: SerializedRenderError
}

export function recordRawMdChunk(chunk: string): void {
  rawMdRing.push(chunk)
  if (rawMdRing.length > RAW_MD_RING_LIMIT) rawMdRing.shift()
}

export function clearRawMdRing(): void {
  rawMdRing.length = 0
  lastIncidentDumpMs = 0
}

/**
 * Persist a render incident (error + raw-chunk ring). Returns the file path,
 * or null when throttled or unwritable. Never throws — this runs inside the
 * render error path.
 */
export function dumpRenderIncident(err: unknown, metadata: RenderIncidentMetadata = {}): string | null {
  const now = Date.now()
  if (now - lastIncidentDumpMs < INCIDENT_THROTTLE_MS) return null
  lastIncidentDumpMs = now
  try {
    const home = process.env['OWLCODA_HOME'] ?? join(homedir(), '.owlcoda')
    const dir = join(home, 'render-incidents')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `render-incident-${now}.json`)
    const errorDetails = metadata.errorDetails ?? serializeRenderError(err)
    const error = `${errorDetails.message}${errorDetails.stack ? `\n${errorDetails.stack}` : ''}`
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      at: new Date(now).toISOString(),
      error,
      errorDetails,
      ...metadata,
      chunks: [...rawMdRing],
    }, null, 2))
    return path
  } catch {
    return null
  }
}

// ─── Full-output recall (/expand) ────────────────────────────────────────
// Ring buffer of recent full tool outputs so collapse never loses data.
// Interactive in-place expansion is future work (spec: C 方案); /expand
// re-prints the recorded output.

interface RecordedToolOutput {
  name: string
  output: string
  isError: boolean
  at: number
}

const RECORD_LIMIT = 20
const recordedOutputs: RecordedToolOutput[] = []

export function recordFullToolOutput(name: string, output: string, isError: boolean): void {
  recordedOutputs.push({ name, output, isError, at: Date.now() })
  if (recordedOutputs.length > RECORD_LIMIT) recordedOutputs.shift()
}

/** offset 0 = most recent. Returns null when out of range. */
export function getRecordedToolOutput(offset = 0): RecordedToolOutput | null {
  if (offset < 0 || offset >= recordedOutputs.length) return null
  return recordedOutputs[recordedOutputs.length - 1 - offset] ?? null
}

export function clearRecordedToolOutputs(): void {
  recordedOutputs.length = 0
}
