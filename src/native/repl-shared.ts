import { statSync, readdirSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { homedir } from 'node:os'

import { probeRuntimeSurface } from '../runtime-probe.js'
import { SLASH_COMMANDS } from './slash-commands.js'
import type { ConversationRuntimeFailure } from './conversation.js'
import wrapText from '../ink/wrap-text.js'
import { dim } from './tui/colors.js'
import type { PickerItem } from './tui/picker.js'

export type FailedContinuationSubmitAction =
  | 'submit_text'
  | 'retry_failed_continuation'
  | 'dedupe_retry_failed_continuation'
  | 'guide_after_repeated_failed_continuation'

export type OnboardingShortcutAction =
  | { kind: 'hint'; message: string }
  | { kind: 'slash'; command: string }
  | { kind: 'draft'; value: string }

export function resolveOnboardingShortcut(text: string): OnboardingShortcutAction | null {
  const raw = text.trim()
  if (!/^0[1-5]$/.test(raw)) return null
  const normalized = raw.slice(1)
  switch (normalized) {
    case '1':
      return { kind: 'hint', message: 'Ask anything: type a request, or use /help for commands.' }
    case '2':
      return { kind: 'slash', command: '/help' }
    case '3':
      return { kind: 'draft', value: '@' }
    case '4':
      return { kind: 'slash', command: '/model' }
    case '5':
      return { kind: 'slash', command: '/settings' }
    default:
      return null
  }
}

const CONTINUATION_RETRY_PHRASES = new Set([
  '继续',
  '续跑',
  '接着',
  '继续一下',
  '继续总结',
  '继续说',
  'continue',
  'resume',
  'go on',
  'carry on',
])

const POLITE_CONTINUATION_RETRY_RE = /^(?:(?:请|请你|麻烦|麻烦你)\s*(?:继续|续跑|接着|继续一下|继续总结|继续说)(?:\s*[吧呀啊嘛])?|(?:please\s+)(?:continue|resume|go on|carry on)(?:\s*please)?)$/i

function normalizeContinuationRetryPhrase(text: string): string {
  return text
    .trim()
    .replace(/[.!?。！？…]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

// Any pre-first-token stream close is retry-eligible, regardless of phase.
// Earlier versions gated on phase in {continuation, tool_continuation}, but
// the typical kimi-code failure strikes on the very first assistant response
// (phase='request') — and users still type "继续" to mean "retry" in that
// case. Restricting by phase made the retry path unreachable for the most
// common real-world failure; broadening it here is the fix.
export function isRetryEligibleContinuationFailure(
  failure: ConversationRuntimeFailure | null | undefined,
): failure is ConversationRuntimeFailure {
  return failure?.retryable === true
    && failure.kind !== 'abort'
    && failure.kind !== 'post_token_stream_close'
}

export function isContinuationRetryInput(text: string): boolean {
  const normalized = normalizeContinuationRetryPhrase(text)
  return CONTINUATION_RETRY_PHRASES.has(normalized)
    || POLITE_CONTINUATION_RETRY_RE.test(normalized)
}

export function decideFailedContinuationSubmitAction(options: {
  text: string
  runtimeFailure: ConversationRuntimeFailure | null | undefined
  isRetryingFailedContinuation: boolean
  failedContinuationAttemptCount: number
}): FailedContinuationSubmitAction {
  if (!isRetryEligibleContinuationFailure(options.runtimeFailure) || !isContinuationRetryInput(options.text)) {
    return 'submit_text'
  }
  if (options.failedContinuationAttemptCount >= 2) {
    return 'guide_after_repeated_failed_continuation'
  }
  return options.isRetryingFailedContinuation
    ? 'dedupe_retry_failed_continuation'
    : 'retry_failed_continuation'
}

// Single retry status line, independent of phase. The phase-specific wording
// was removed alongside phase-gated eligibility — there's no functional reason
// to surface three different retry banners when the user just wants confirmation
// that a retry is in flight.
export function formatContinuationRetryStatus(_failure: ConversationRuntimeFailure): string {
  return 'Retrying failed request...'
}

export function formatRepeatedContinuationRetryGuidance(
  _failure: ConversationRuntimeFailure,
  attemptCount: number,
): string {
  const attempts = Math.max(2, attemptCount)
  return `Request is still failing after ${attempts} attempts. Use /model to switch, or /retry to force another resend.`
}

export function shouldScheduleRuntimeAutoRetry(options: {
  runtimeFailure: ConversationRuntimeFailure | null
  taskAborted: boolean
  clearEpochUnchanged: boolean
  currentRetryCount: number
  retryLimit: number
  hasQueuedInput: boolean
}): boolean {
  return options.runtimeFailure !== null
    && options.runtimeFailure.retryable === true
    && options.runtimeFailure.kind !== 'pre_first_token_stream_close'
    && !options.taskAborted
    && options.clearEpochUnchanged
    && options.currentRetryCount < options.retryLimit
    && !options.hasQueuedInput
}

export function shouldDrainQueuedInputAfterTurn(options: {
  hasQueuedInput: boolean
  taskFailed: boolean
  autoRetryFailure: ConversationRuntimeFailure | null
}): boolean {
  return options.hasQueuedInput
    && (!options.taskFailed || options.autoRetryFailure !== null)
}

export function shouldQueueSubmitBehindRunningTask(options: {
  isLoading: boolean
  hasActiveTask: boolean
  hasScheduledAutoRetry: boolean
}): boolean {
  return options.hasActiveTask || (options.isLoading && !options.hasScheduledAutoRetry)
}

// Pseudo tool-call markers that can leak into streaming assistant text
// when the model hallucinates tool invocation syntax instead of using the
// real tool_use block. The runtime's synthesis validator catches these at
// the synthesis phase (src/native/conversation.ts PSEUDO_TOOL_CALL_RE),
// but pre-synthesis streaming has no filter — the frontend scrubs for
// visibility.
//
// The regex has two layers:
//   1. Full-block matchers for paired wrappers — consume everything
//      inside [TOOL_CALL]…[/TOOL_CALL], <invoke>…</invoke>,
//      <tool_call>…</tool_call>, and <minimax:tool_call>…</minimax:tool_call>
//      so nested <path>, <arg>, JSON, etc. don't survive the scrub.
//   2. Bare-token fallbacks for orphan opening/closing markers that arrive
//      split across streaming chunks.
const PSEUDO_TOOL_CALL_MARKER_RE = /\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]|\[\/?TOOL_CALL\]|<invoke\b[^>]*>[\s\S]*?<\/invoke>|<(?:minimax:)?tool_call\b[^>]*>[\s\S]*?<\/(?:minimax:)?tool_call>|<\/?(?:minimax:)?tool_call\b[^>]*>|<\/?invoke\b[^>]*>/gi

/**
 * Replaces pseudo tool-call markers in streaming assistant text with a
 * single dim placeholder on first occurrence per turn. Subsequent matches
 * within the same turn are silently dropped (to avoid repeated noise).
 *
 * State must be reset at turn end by resetting `state.elided = false`.
 *
 * Known limitations (accepted trade-offs):
 * 1. Chunk-level regex cannot distinguish legitimate backtick-wrapped
 *    discussion of the syntax from raw model hallucination. Real-world
 *    frequency of model pseudo-tool-call emission far exceeds user
 *    questions about the syntax, so false-positives on legit quotes are
 *    rare and recoverable (the elided placeholder signals what happened).
 * 2. Markers split across streaming-chunk boundaries leak the fragments
 *    on either side. e.g. chunk "`abc[TO`" + chunk "`OL_CALL]{...}[/TOOL_CALL]`"
 *    leaves "`OL_CALL]{...}`" visible on the second chunk because neither
 *    chunk alone contains a full marker. Best-effort guard, not a hard
 *    filter. Most real streams emit markers in a single chunk.
 */
export function scrubPseudoToolCall(
  chunk: string,
  state: { elided: boolean },
): string {
  let elidedThisCall = false
  const placeholder = `\n${dim('↪ [pseudo tool-call syntax elided]')}\n`
  const result = chunk.replace(PSEUDO_TOOL_CALL_MARKER_RE, () => {
    if (state.elided || elidedThisCall) return ''
    elidedThisCall = true
    return placeholder
  })
  if (elidedThisCall) state.elided = true
  return result
}

// ─── Assistant composition layer ────────────────────────────────────
//
// Pre-transforms streaming assistant text by recognizing 16 semantic
// anchors (4 tiers × 2 Chinese + 2 English each) and translating them
// into markdown shapes the existing StreamingMarkdownRenderer already
// handles. No renderer changes required.
//
// Matching rules:
//   - Anchors match only at line-start (^\s*) or sentence-start
//     (after .!?。！？ + whitespace). No mid-prose matching.
//   - Case-sensitive for English anchors (models emit these capitalized
//     at sentence start; lowercase in prose is almost always the word
//     "conclusion" used in a sentence, not an anchor).
//
// Fallback: when a chunk contains ZERO anchor hits AND at least one
// substring between sentence boundaries exceeds the length threshold
// (80 chars Latin / 40 chars when CJK is present), insert \n at
// sentence boundaries. No bullet/prefix injection.
//
// Cross-chunk: trailing partial lines (no newline at chunk end) are
// held in `state.leftover` and prepended to the next chunk, so an
// anchor split across two chunks still matches. Soft cap 512 chars;
// beyond that, the leftover is flushed through to avoid infinite buffering.
//
// See internal/superpowers/specs/2026-04-18-assistant-composition-layer-design.md
// for the full design rationale.

export type AnchorTier = 'conclusion' | 'next' | 'evidence' | 'uncertainty'

export interface ComposeState {
  seenAnchors: Set<AnchorTier>
  leftover: string
}

const ANCHOR_TO_TIER: ReadonlyMap<string, AnchorTier> = new Map([
  ['结论:', 'conclusion'],
  ['当前判断:', 'conclusion'],
  ['Conclusion:', 'conclusion'],
  ['Result:', 'conclusion'],
  ['下一步:', 'next'],
  ['接下来:', 'next'],
  ['Next:', 'next'],
  ['Next step:', 'next'],
  ['证据:', 'evidence'],
  ['发现:', 'evidence'],
  ['Evidence:', 'evidence'],
  ['Finding:', 'evidence'],
  ['风险:', 'uncertainty'],
  ['不确定:', 'uncertainty'],
  ['Risk:', 'uncertainty'],
  ['Uncertainty:', 'uncertainty'],
])

function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Order matters for alternation: longer literals must come before their
// prefixes so "Next step:" matches before "Next:" alone. Sort by length desc.
const ANCHOR_ALT = Array.from(ANCHOR_TO_TIER.keys())
  .sort((a, b) => b.length - a.length)
  .map(reEscape)
  .join('|')

// Line-start anchor: start of line, optional whitespace, anchor, required whitespace.
const LINE_START_ANCHOR_RE = new RegExp(`^(\\s*)(${ANCHOR_ALT})\\s+`)

// Sentence-start anchor: sentence-ender + whitespace, then anchor + whitespace. Global.
const SENTENCE_START_ANCHOR_RE = new RegExp(`([.!?。！？])\\s+(${ANCHOR_ALT})\\s+`, 'g')

function formatAnchor(anchor: string, tier: AnchorTier): string {
  switch (tier) {
    case 'conclusion':  return `**${anchor}**`
    case 'next':        return `→ **${anchor}**`
    case 'evidence':    return `> **${anchor}**`
    case 'uncertainty': return `> [!] **${anchor}**`
  }
}

const LEFTOVER_SOFT_CAP = 512

/**
 * Pre-transform a streaming assistant chunk. Recognizes semantic anchors
 * (Conclusion / Next / Evidence / Uncertainty in Chinese + English) at
 * line-start or sentence-start positions and rewrites them into markdown
 * shapes the renderer already handles. Falls back to sentence-level
 * newline insertion when no anchor is present and prose is long.
 *
 * Pure function. Mutates `state` in place for cross-chunk continuity.
 *
 * Known limitations (accepted trade-offs):
 * 1. Chunk-level regex cannot distinguish legitimate backtick-wrapped
 *    discussion of the syntax (e.g. the string `Conclusion:` inside a
 *    code span) from raw anchor usage. Real-world frequency of model
 *    hallucination vastly exceeds user questions about the syntax.
 * 2. An anchor straddling the soft-cap (512 chars) leftover flush may
 *    leak fragments on either side, because the tail was forced through
 *    processing before the next chunk could join it. Pathological only —
 *    realistic streams emit anchors well within one line before flushing.
 * 3. The CJK detector `/[\u4e00-\u9fff]/` covers CJK Unified Ideographs
 *    only. Japanese Hiragana/Katakana-only prose or Korean Hangul-only
 *    prose would use the 80-char Latin threshold; mixed content with
 *    any CJK Unified char correctly uses the 40-char CJK threshold.
 */
export function composeAssistantChunk(
  chunk: string,
  state: ComposeState,
): string {
  const working = state.leftover + chunk
  state.leftover = ''

  const lines = working.split('\n')
  let completeLines: string[]

  if (working.endsWith('\n')) {
    // Last element is '' — drop it
    completeLines = lines.slice(0, -1)
  } else {
    const tail = lines[lines.length - 1] ?? ''
    completeLines = lines.slice(0, -1)
    if (tail.length > LEFTOVER_SOFT_CAP) {
      // Soft cap exceeded — flush rather than buffer indefinitely
      completeLines.push(tail)
    } else {
      state.leftover = tail
    }
  }

  if (completeLines.length === 0) {
    return ''
  }

  // Anchor pass: translate line-start and sentence-start anchors.
  let anyAnchorHit = false
  const translated = completeLines.map((line) => {
    // Line-start anchor
    const lsMatch = line.match(LINE_START_ANCHOR_RE)
    if (lsMatch) {
      const anchor = lsMatch[2] ?? ''
      const tier = ANCHOR_TO_TIER.get(anchor)
      if (tier) {
        anyAnchorHit = true
        state.seenAnchors.add(tier)
        const leadingWs = lsMatch[1] ?? ''
        const rest = line.slice(lsMatch[0].length)
        return `${leadingWs}${formatAnchor(anchor, tier)} ${rest}`
      }
    }

    // Sentence-start anchor(s) inside the line
    let sentenceHit = false
    const withInline = line.replace(SENTENCE_START_ANCHOR_RE, (_m, sep, anchor) => {
      const tier = ANCHOR_TO_TIER.get(anchor)
      if (!tier) return _m
      sentenceHit = true
      state.seenAnchors.add(tier)
      return `${sep}\n${formatAnchor(anchor, tier)} `
    })
    if (sentenceHit) {
      anyAnchorHit = true
      return withInline
    }

    return line
  })

  // If any anchor fired, skip fallback — the anchor already supplies structure.
  if (anyAnchorHit) {
    return translated.join('\n') + '\n'
  }

  // Fallback pass: sentence-level split for long prose.
  const split = translated.map(fallbackSplitIfLong)
  return split.join('\n') + '\n'
}

function fallbackSplitIfLong(line: string): string {
  const hasCJK = /[\u4e00-\u9fff]/.test(line)
  const threshold = hasCJK ? 40 : 80

  // Segments between sentence boundaries (keeping the boundary in the left segment).
  // Latin enders (.!?) require trailing whitespace. CJK enders (。！？) split
  // with zero-or-more whitespace since Chinese convention omits inter-sentence spaces.
  const segments = line.split(/(?<=[.!?])\s+|(?<=[。！？])\s*/).filter((s) => s.length > 0)

  // No actual sentence boundaries found — nothing to split.
  if (segments.length < 2) return line

  // Spec-literal trigger: split only when at least ONE individual segment
  // exceeds the threshold. Short sentences bundled together stay bundled
  // regardless of total line length — we do not second-guess the author's
  // intent to keep the grouping if each sentence is already short.
  const anyLong = segments.some((s) => s.length > threshold)
  if (!anyLong) return line

  return segments.join('\n')
}

type KeypressInfo = {
  name?: string
  shift?: boolean
  meta?: boolean
  ctrl?: boolean
}

export interface InputSignalState {
  continueMultiline: boolean
  pasteStart: boolean
  pasteEnd: boolean
}

export interface BufferedInputSignalState extends InputSignalState {
  remainder: string
}

export interface BufferedMouseArtifactState {
  cleaned: string
  remainder: string
  sawMouseSequence: boolean
}

export interface SyntheticLineSuppression {
  until: number
  acceptedLines: string[]
}

export interface PromptBufferRow {
  text: string
  placeholder: boolean
}

export function buildPromptBufferRows(
  committedLines: string[],
  currentLine: string,
  visibleRows: number,
): { rows: PromptBufferRow[]; cursorRow: number } {
  const logicalRows = [...committedLines, currentLine]
  const sliceStart = Math.max(0, logicalRows.length - visibleRows)
  const visible = logicalRows.slice(sliceStart)
  const rows: PromptBufferRow[] = visible.map((text) => ({ text, placeholder: false }))
  const cursorRow = Math.max(0, rows.length - 1)
  while (rows.length < visibleRows) {
    rows.push({ text: '', placeholder: true })
  }
  return { rows, cursorRow }
}

export function composeBufferedInput(
  committedLines: string[],
  currentLine: string,
): string {
  if (committedLines.length === 0) return currentLine.trim()
  return [...committedLines, currentLine].join('\n').trim()
}

const MODIFIED_ENTER_SEQUENCES = [
  '\x1b[13;2u',
  '[13;2u',
  '13;2u',
  '\x1b[13~',
  '[13~',
  '13~',
  '\x1b[27;2;13~',
  '[27;2;13~',
  '27;2;13~',
  '\x1b\r',
  '\x1b\n',
] as const

const PASTE_START_SEQUENCE = '\x1b[200~'
const PASTE_END_SEQUENCE = '\x1b[201~'

const RAW_INPUT_SIGNAL_SEQUENCES = [
  ...MODIFIED_ENTER_SEQUENCES,
  PASTE_START_SEQUENCE,
  PASTE_END_SEQUENCE,
] as const

const LEAKED_MODIFIED_ENTER_SUFFIXES = [
  '\x1b[13;2u',
  '[13;2u',
  '13;2u',
  '\x1b[13~',
  '[13~',
  '13~',
  '\x1b[27;2;13~',
  '27;2;13~',
] as const

const SGR_MOUSE_TAIL_BEFORE_HEAD_RE = /\d+[Mm](?=(?:\x1b)?\[<)/g

function parseMouseSequencePrefix(
  input: string,
  start: number,
): { complete: boolean; end: number } | null {
  let index = start
  if (input[index] === '\x1b') index += 1
  if (input[index] !== '[' || input[index + 1] !== '<') return null
  index += 2

  for (let part = 0; part < 3; part += 1) {
    const numberStart = index
    while (index < input.length && /\d/.test(input[index] ?? '')) {
      index += 1
    }

    if (index === numberStart) {
      return { complete: false, end: input.length }
    }

    if (part < 2) {
      if (index >= input.length) {
        return { complete: false, end: input.length }
      }
      if (input[index] !== ';') return null
      index += 1
    }
  }

  if (index >= input.length) {
    return { complete: false, end: input.length }
  }

  const terminator = input[index]
  if (terminator !== 'M' && terminator !== 'm') return null
  return { complete: true, end: index + 1 }
}

export function stripSgrMouseArtifacts(input: string): string {
  if (!input) return ''

  let cleaned = input.replace(SGR_MOUSE_TAIL_BEFORE_HEAD_RE, '')
  let result = ''

  for (let index = 0; index < cleaned.length;) {
    const parsed = parseMouseSequencePrefix(cleaned, index)
    if (parsed?.complete) {
      index = parsed.end
      continue
    }
    result += cleaned[index] ?? ''
    index += 1
  }

  return result
}

export function stripBufferedMouseArtifacts(
  str: string,
  remainder = '',
): BufferedMouseArtifactState {
  const combined = remainder + str
  if (!combined) {
    return { cleaned: '', remainder: '', sawMouseSequence: false }
  }

  const normalized = combined.replace(SGR_MOUSE_TAIL_BEFORE_HEAD_RE, '')
  let cleaned = ''
  let nextRemainder = ''
  let sawMouseSequence = false

  for (let index = 0; index < normalized.length;) {
    const parsed = parseMouseSequencePrefix(normalized, index)
    if (parsed) {
      sawMouseSequence = true
      if (parsed.complete) {
        index = parsed.end
        continue
      }
      nextRemainder = normalized.slice(index)
      break
    }
    cleaned += normalized[index] ?? ''
    index += 1
  }

  return {
    cleaned,
    remainder: nextRemainder,
    sawMouseSequence,
  }
}

export function detectInputSignals(str: string, key?: KeypressInfo): InputSignalState {
  const keyName = key?.name?.toLowerCase()
  const modifiedEnter = (keyName === 'return' || keyName === 'enter') && (key?.shift || key?.meta)
  return {
    continueMultiline: modifiedEnter || MODIFIED_ENTER_SEQUENCES.some((seq) => str.includes(seq)),
    pasteStart: str.includes(PASTE_START_SEQUENCE),
    pasteEnd: str.includes(PASTE_END_SEQUENCE),
  }
}

export function stripModifiedEnterArtifacts(line: string): string {
  let cleaned = line
  let changed = true
  while (changed) {
    changed = false
    for (const suffix of LEAKED_MODIFIED_ENTER_SUFFIXES) {
      if (cleaned.endsWith(suffix)) {
        cleaned = cleaned.slice(0, -suffix.length)
        changed = true
      }
    }
  }
  return cleaned
}

function findInputSignalRemainder(str: string): string {
  const maxPrefixLength = Math.max(...RAW_INPUT_SIGNAL_SEQUENCES.map((seq) => seq.length - 1))
  const searchStart = Math.max(0, str.length - maxPrefixLength)
  for (let index = searchStart; index < str.length; index++) {
    const suffix = str.slice(index)
    if (RAW_INPUT_SIGNAL_SEQUENCES.some((seq) => seq.startsWith(suffix))) {
      return suffix
    }
  }
  return ''
}

export function detectBufferedInputSignals(
  str: string,
  remainder = '',
): BufferedInputSignalState {
  const combined = remainder + str
  const signals = detectInputSignals(combined)
  let stripped = combined
  for (const seq of RAW_INPUT_SIGNAL_SEQUENCES) {
    stripped = stripped.split(seq).join('')
  }
  return {
    ...signals,
    remainder: findInputSignalRemainder(stripped),
  }
}

export function createSyntheticLineSuppression(
  committedLine: string,
  now = Date.now(),
): SyntheticLineSuppression {
  return {
    until: now + 100,
    acceptedLines: Array.from(new Set(['', stripModifiedEnterArtifacts(committedLine)])),
  }
}

export function shouldIgnoreSyntheticLine(
  line: string,
  suppression: SyntheticLineSuppression | null,
  now = Date.now(),
): boolean {
  if (!suppression || now > suppression.until) return false
  const cleaned = stripModifiedEnterArtifacts(line)
  return suppression.acceptedLines.includes(cleaned)
}

export function shouldOpenSlashPickerOnKeypress(
  str: string,
  currentLine: string,
  hasActiveTask: boolean,
  inMultiline: boolean,
  pickerActive: boolean,
): boolean {
  if (pickerActive || hasActiveTask || inMultiline) return false
  if (str !== '/') return false
  return currentLine === '' || currentLine === '/'
}

export function formatResumeCommand(sessionId: string): string {
  return `owlcoda --resume ${sessionId}`
}

export function classifyResolvedInput(
  input: string,
  hasRunningTask: boolean,
): 'task_ignore' | 'task_block_slash' | 'idle_empty' | 'submit' {
  if (hasRunningTask) {
    if (!input) return 'task_ignore'
    if (input.startsWith('/')) return 'task_block_slash'
    return 'task_ignore'
  }
  if (!input) return 'idle_empty'
  return 'submit'
}

export function shouldSuppressReadlineRefresh(
  promptDockVisible: boolean,
  hasRunningTask: boolean,
): boolean {
  return !promptDockVisible && hasRunningTask
}

export async function preflightCheck(apiBaseUrl: string): Promise<boolean> {
  const probe = await probeRuntimeSurface(apiBaseUrl, 5000)
  return probe.ok
}

export function slashCompleter(line: string): [string[], string] {
  if (line.startsWith('/')) {
    const hits = SLASH_COMMANDS.filter((command) => command.startsWith(line))
    return [hits.length > 0 ? hits : SLASH_COMMANDS, line]
  }

  const lastToken = line.split(/\s+/).pop() ?? ''
  if (lastToken.includes('/') || lastToken.startsWith('.') || lastToken.startsWith('~')) {
    try {
      let expanded = lastToken.startsWith('~') ? lastToken.replace('~', homedir()) : lastToken
      expanded = resolve(expanded)

      let dir: string
      let prefix: string
      try {
        if (statSync(expanded).isDirectory()) {
          dir = expanded
          prefix = ''
        } else {
          dir = dirname(expanded)
          prefix = basename(expanded)
        }
      } catch {
        dir = dirname(expanded)
        prefix = basename(expanded)
      }

      const entries = readdirSync(dir, { withFileTypes: true })
      const matches = entries
        .filter((entry) => entry.name.startsWith(prefix) && !entry.name.startsWith('.'))
        .slice(0, 30)
        .map((entry) => {
          let path: string
          if (lastToken.startsWith('/')) {
            path = join(dir, entry.name)
          } else {
            const base = lastToken.endsWith('/') ? lastToken : dirname(lastToken) + '/'
            path = base + entry.name
          }
          return entry.isDirectory() ? `${path}/` : path
        })

      if (matches.length > 0) {
        return [matches, lastToken]
      }
    } catch {
      // Ignore invalid path completion attempts.
    }
  }

  return [[], line]
}

const SLASH_PICKER_HINTS: Record<string, string> = {
  '/help': 'Command reference and search',
  '/model': 'Switch models',
  '/clear': 'Reset conversation',
  '/compact': 'Trim older turns',
  '/budget': 'Show token budget',
  '/save': 'Save current session',
  '/sessions': 'List saved sessions',
  '/turns': 'Show turn count',
  '/cost': 'Token usage breakdown',
  '/tokens': 'Token usage (alias for /cost)',
  '/status': 'Session info and runtime state',
  '/settings': 'Open settings panel',
  '/config': 'Show runtime configuration',
  '/capabilities': 'List supported features',
  '/doctor': 'Run environment diagnostics',
  '/trace': 'Toggle debug trace logging',
  '/session': 'Show current session',
  '/resume': 'Resume a saved session',
  '/history': 'View conversation messages',
  '/export': 'Export session (json/markdown)',
  '/dashboard': 'Inspect runtime metrics',
  '/audit': 'Inspect recent requests',
  '/health': 'Check runtime health',
  '/ratelimit': 'Rate limit status',
  '/slo': 'Error budget and SLO status',
  '/traces': 'View recent timing waterfalls',
  '/perf': 'Performance metrics',
  '/metrics': 'Prometheus-format metrics',
  '/reset-circuits': 'Reset circuit breakers',
  '/reset-budgets': 'Reset error budgets',
  '/backends': 'Discover local backends',
  '/recommend': 'Model recommendation by intent',
  '/warmup': 'Warm up model backends',
  '/plugins': 'List installed plugins',
  '/models': 'Model workstation — unified view, status, issues',
  '/why-native': 'Explain native mode',
  '/approve': 'Toggle auto-approve for tools',
  '/branch': 'Create a session branch',
  '/branches': 'List session branches',
  '/tag': 'Manage session tags',
  '/compress': 'Compact session history',
  '/theme': 'Switch terminal theme',
  '/themes': 'Switch terminal theme',
  '/thinking': 'Control reasoning visibility',
  '/undo': 'Remove last turn pair',
  '/retry': 'Resend last message',
  '/rewind': 'Remove last N turn pairs',
  '/context': 'Show context window usage',
  '/plan': 'Plan mode status',
  '/permissions': 'Show tool permissions',
  '/diff': 'Show git diff',
  '/memory': 'Show OWLCODA.md memory',
  '/rename': 'Rename current session',
  '/init': 'Create OWLCODA.md in project',
  '/verbose': 'Toggle verbose tool output',
  '/quit': 'Exit OwlCoda',
  '/exit': 'Exit OwlCoda',
  '/version': 'Show version info',
  '/files': 'List files in conversation context',
  '/stats': 'Session statistics',
  '/brief': 'Toggle brief response mode',
  '/fast': 'Toggle fast mode',
  '/effort': 'Set effort level (low/medium/high)',
  '/color': 'Color mode settings',
  '/vim': 'Toggle vim keybindings',
  '/btw': 'Inject context note',
  '/commit': 'Generate commit message',
  '/release-notes': 'Generate release notes',
  '/skills': 'Browse available skills',
  '/tasks': 'View background tasks',
  '/mcp': 'MCP server management',
  '/hooks': 'View registered hooks',
  '/pr-comments': 'View PR comments',
  '/review': 'Request code review',
  '/add-dir': 'Add directory to context',
  '/login': 'Authentication info',
  '/search': 'Search across files or history',
  '/editor': 'Open editor for multi-line input',
}

export const SLASH_COMMANDS_REQUIRING_ARGS = new Set([
  '/resume',
  '/rename',
  '/branch',
  '/tag',
  '/export',
  '/review',
  '/add-dir',
  '/release-notes',
  '/pr-comments',
  '/effort',
  '/color',
  '/commit',
  '/search',
])

/** Common keyboard shortcuts for slash commands — surfaced in the picker
 *  per the design's `oc-picker-item.slash` shortcut column. Only the
 *  commands that actually have a global shortcut are listed; everything
 *  else gets an empty cell so the column still aligns. */
const SLASH_PICKER_SHORTCUTS: Record<string, string> = {
  '/help':     '?',
  '/clear':    '⌃L',
  '/settings': '⌃,',
  '/quit':     '⌃D',
  '/exit':     '⌃D',
}

export function buildSlashPickerItems(): PickerItem<string>[] {
  return SLASH_COMMANDS.map((command) => ({
    label: command,
    description: SLASH_PICKER_HINTS[command] ?? 'Command',
    value: command,
    shortcut: SLASH_PICKER_SHORTCUTS[command] ?? '',
  }))
}

// ─── Transcript viewport utilities ──────────────────────────────

export type TranscriptItem = {
  id: string
  text: string
}

export interface OcWorkingIndicatorOptions {
  frame: number
  elapsedSeconds: number
  model: string
  phase?: 'awaiting_model' | 'tool_execution' | 'busy'
  activeToolName?: string
  detail?: string
}

// OC spinner — braille dot spinner next to the OC brand mark.
// Clearly animated at 90ms tick, compact (4 chars), OC stays as visual anchor.
const OC_SPINNER_CHARS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function buildOcLoaderFrame(frame: number): string {
  const spinner = OC_SPINNER_CHARS[Math.abs(frame) % OC_SPINNER_CHARS.length] ?? '⠋'
  return `${spinner} OC`
}

export function buildOcWorkingIndicatorLines(
  options: OcWorkingIndicatorOptions,
): string[] {
  const loader = buildOcLoaderFrame(options.frame)
  const elapsed = Math.max(0, options.elapsedSeconds)
  const detail = options.detail?.trim() || (() => {
    if (options.phase === 'tool_execution') {
      return options.activeToolName ? `Running ${options.activeToolName}` : 'Running tool'
    }
    if (options.phase === 'busy') {
      return 'Retrying request'
    }
    return `Waiting for ${options.model}`
  })()

  const line1 = `${loader}  ${detail} · ${elapsed}s · Ctrl+C interrupt`

  // Animated pulse bar during extended awaiting_model waits.
  // Gives continuous visual confirmation the system is alive and working.
  if (elapsed >= 5 && options.phase !== 'tool_execution' && options.phase !== 'busy') {
    const barWidth = 20
    const period = barWidth * 2
    const pos = Math.abs(options.frame) % period
    const dotPos = pos < barWidth ? pos : period - 1 - (pos - barWidth)
    const bar = '░'.repeat(dotPos) + '▓▓' + '░'.repeat(Math.max(0, barWidth - dotPos - 2))
    return [line1, `  ${bar}`]
  }

  return [line1]
}

// Inline status line for the transcript area — shows phase-aware, evolving text.
// This is the PRIMARY status display, positioned right after the user's message.
// Separate from the branded bottom panel to avoid duplication.
export interface InlineStatusOptions {
  frame: number
  elapsedSeconds: number
  model: string
  phase?: 'awaiting_model' | 'tool_execution' | 'busy'
  activeToolName?: string
  detail?: string
  /**
   * Milliseconds since the last concrete progress event (token arrival,
   * tool progress tick, tool start/end, retry notice, etc.). When
   * exceeded past STALL_THRESHOLD_MS, a `· idle Xs` suffix is appended
   * so the user can see that work has stopped streaming — the task may
   * still be running remotely (long tool call, slow backend), but we
   * disambiguate "still producing output" vs. "waiting silently".
   *
   * Omit or pass 0 to disable the suffix (used at task start before
   * the first progress event lands).
   */
  stallMs?: number
}

/** Threshold past which we surface a "no progress" suffix. Shorter than
 * the user's patience window — they should see the stall within a few
 * seconds of it happening, not after they've already decided it's dead.
 */
const STALL_THRESHOLD_MS = 3000

/**
 * Format the stall suffix. Kept lowercase and dim-ready so it reads as
 * status telemetry, not a warning. The suffix is appended to every
 * phase, not just awaiting_model — a tool that stops emitting progress
 * (e.g. bash blocked on network I/O) deserves the same visibility.
 */
function formatStallSuffix(stallMs?: number): string {
  if (!stallMs || stallMs < STALL_THRESHOLD_MS) return ''
  const seconds = Math.floor(stallMs / 1000)
  return ` · idle ${seconds}s`
}

export function buildInlineStatusLine(options: InlineStatusOptions): string {
  const chars = OC_SPINNER_CHARS
  const spinner = chars[Math.abs(options.frame) % chars.length] ?? '⠋'
  const elapsed = Math.max(0, options.elapsedSeconds)
  const stallSuffix = formatStallSuffix(options.stallMs)

  if (options.detail?.trim()) {
    return `${spinner} ${options.detail.trim()}${stallSuffix}`
  }

  if (options.phase === 'tool_execution') {
    const name = options.activeToolName ?? 'tool'
    const base = elapsed > 0
      ? `${spinner} Running ${name}… · ${elapsed}s`
      : `${spinner} Running ${name}…`
    return `${base}${stallSuffix}`
  }

  if (options.phase === 'busy') {
    return `${spinner} Retrying request…${stallSuffix}`
  }

  // awaiting_model: evolving copy as elapsed time increases
  if (elapsed < 3) {
    return `${spinner} Thinking…${stallSuffix}`
  }
  if (elapsed < 8) {
    return `${spinner} Thinking… · reading context${stallSuffix}`
  }
  if (elapsed < 15) {
    return `${spinner} Waiting for ${options.model} · ${elapsed}s${stallSuffix}`
  }
  if (elapsed < 30) {
    return `${spinner} Waiting for ${options.model} · ${elapsed}s — almost there${stallSuffix}`
  }
  return `${spinner} Waiting for ${options.model} · ${elapsed}s — long response in progress${stallSuffix}`
}

// ─── Scroll indicator bar ──────────────────────────────────────
// Full-width visual scroll bar that serves as the primary scroll affordance.
// Upstream uses a floating pill; OwlCoda uses a persistent position bar.

export interface ScrollIndicatorOptions {
  /** Terminal width */
  cols: number
  /** Total lines in transcript */
  totalLines: number
  /** Lines visible in viewport */
  budgetLines: number
  /** Current scroll offset (0 = live) */
  scrollOffset: number
  /** Maximum scroll offset */
  maxScrollOffset: number
  /** View end line position */
  viewEndLine: number
  /** Is user scrolled away from live? */
  isScrolledAway: boolean
  /** Is there more content than fits? */
  isScrollable: boolean
  /** Is a task currently running? */
  isLoading: boolean
  /** Number of new content items since scroll-away */
  newContentCount: number
  /** Spinner frame for animation */
  frame: number
}

export function buildScrollIndicatorBar(options: ScrollIndicatorOptions): string {
  const { totalLines, budgetLines, viewEndLine, isScrolledAway, isScrollable, isLoading, newContentCount, frame } = options

  // Not scrollable: minimal live indicator
  if (!isScrollable && totalLines <= budgetLines) {
    return '  ▶ live'
  }

  const posPercent = totalLines > 0 ? Math.round((viewEndLine / totalLines) * 100) : 100
  const lineCounter = `L${viewEndLine}/${totalLines}`

  if (isScrolledAway && isLoading) {
    // Animated new-content indicator during loading while scrolled away
    const pulse = ['↓', '⬇', '↓', '⇣'][Math.abs(frame) % 4]
    const label = newContentCount > 0 ? `${pulse} ${newContentCount} new below` : `${pulse} new content below`
    return `  ${label}  ${posPercent}% ${lineCounter}  Ctrl+↓ live`
  }

  if (isScrolledAway) {
    return `  ↑ history  ${posPercent}% ${lineCounter}  PgUp/Dn app scroll · mouse=terminal copy/scrollback · Ctrl+↓ live`
  }

  // At live, scrollable
  return `  ▶ live  ${lineCounter}  PgUp/Dn app scroll · mouse=terminal copy/scrollback`
}

/**
 * Parse one SGR mouse wheel report from stdin data.
 * Returns +1 for wheel up, -1 for wheel down, 0 when no wheel event is present.
 *
 * Supports modifier variants by masking with 0x43, matching upstream's
 * wheel detection semantics.
 */
export function parseSgrWheelDelta(input: string): number {
  const sgrMatch = input.match(/\x1b\[<(\d+);\d+;\d+[Mm]/)
  if (!sgrMatch) return 0
  const button = Number.parseInt(sgrMatch[1] ?? '', 10)
  if (!Number.isFinite(button)) return 0
  if ((button & 0x43) === 0x40) return 1
  if ((button & 0x43) === 0x41) return -1
  return 0
}

export function estimateWrappedLineCount(text: string, width: number): number {
  const safeWidth = Math.max(1, width)
  // Hot path: this runs on every draft keystroke for both composer height
  // calculations. Avoid the full wrapper for the overwhelmingly common
  // single-line ASCII draft while preserving the slower path for ANSI,
  // CJK/emoji, and explicit newlines.
  if (!text.includes('\n') && /^[\x20-\x7E]*$/.test(text)) {
    return Math.max(1, Math.ceil(text.length / safeWidth))
  }
  return getDisplayLines(text, safeWidth).length
}

function getDisplayLines(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width)
  const logicalLines = text.split('\n')
  const displayLines: string[] = []

  for (const logicalLine of logicalLines) {
    const wrapped = wrapText(logicalLine, safeWidth, 'wrap').split('\n')
    if (wrapped.length === 0) {
      displayLines.push('')
      continue
    }
    displayLines.push(...wrapped)
  }

  return displayLines
}

export function countTranscriptLines(items: TranscriptItem[], width: number): number {
  return items.reduce((total, item) => total + getDisplayLines(item.text, width).length, 0)
}

// Scroll commands use terminal semantics: negative = older/up, positive =
// newer/down. Our internal offset is measured away from live, so the sign
// flips when applying the delta.
export function applyTranscriptScrollDelta(scrollOffset: number, dy: number): number {
  return Math.max(0, scrollOffset - Math.trunc(dy))
}

// Preserve the user's current history viewport when the live region grows or
// the available transcript budget changes under it.
export function reconcileTranscriptScrollOffset(input: {
  scrollOffset: number
  isSticky: boolean
  prevTotalLines: number
  nextTotalLines: number
  prevBudgetLines: number
  nextBudgetLines: number
}): number {
  if (input.isSticky) return 0

  const contentGrowth = Math.max(0, input.nextTotalLines - input.prevTotalLines)
  const budgetDelta = input.prevBudgetLines - input.nextBudgetLines
  return Math.max(0, input.scrollOffset + contentGrowth + budgetDelta)
}

export function selectVisibleTranscriptItems(
  items: TranscriptItem[],
  width: number,
  maxLines: number,
): TranscriptItem[] {
  if (items.length === 0 || maxLines <= 0) return []

  const visible: TranscriptItem[] = []
  let used = 0
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!
    const lineCost = estimateWrappedLineCount(item.text, width)
    if (visible.length > 0 && used + lineCost > maxLines) {
      break
    }
    visible.unshift(item)
    used += lineCost
    if (used >= maxLines) break
  }
  return visible
}

// ─── Line-based windowed viewport ──────────────────────────────
// Upstream-aligned scroll model: scroll offset is in terminal lines,
// not transcript items. This gives fine-grained scroll, true position
// sense, and natural mouse wheel / trackpad behavior.

export interface TranscriptWindowResult {
  /** Items visible in the viewport */
  visible: TranscriptItem[]
  /** Total line count of entire transcript */
  totalLines: number
  /** First visible line (0-based, from top of transcript) */
  viewStartLine: number
  /** Last visible line (exclusive) */
  viewEndLine: number
  /** Number of items hidden above the viewport */
  hiddenAboveCount: number
  /** Number of items hidden below the viewport */
  hiddenBelowCount: number
  /** Clamped scroll offset (may differ from input if over max) */
  clampedOffset: number
  /** Maximum allowed scroll offset */
  maxScrollOffset: number
}

export function selectVisibleTranscriptWindow(
  items: TranscriptItem[],
  width: number,
  budgetLines: number,
  scrollLineOffset: number,
): TranscriptWindowResult {
  const empty: TranscriptWindowResult = {
    visible: [], totalLines: 0, viewStartLine: 0, viewEndLine: 0,
    hiddenAboveCount: 0, hiddenBelowCount: 0, clampedOffset: 0, maxScrollOffset: 0,
  }
  if (items.length === 0 || budgetLines <= 0) return empty

  // Pre-compute exact display lines for all items using the same wrapping
  // primitive Ink text rendering uses. This keeps the scrollbar range,
  // viewport slice, and mounted content in the same line-space, including
  // CJK and long wrapped tool output.
  const displayLinesByItem: string[][] = new Array(items.length)
  const lineCosts: number[] = new Array(items.length)
  let totalLines = 0
  for (let i = 0; i < items.length; i++) {
    const displayLines = getDisplayLines(items[i]!.text, width)
    const cost = displayLines.length
    displayLinesByItem[i] = displayLines
    lineCosts[i] = cost
    totalLines += cost
  }

  // Clamp scroll offset
  const maxScrollOffset = Math.max(0, totalLines - budgetLines)
  const clampedOffset = Math.max(0, Math.min(scrollLineOffset, maxScrollOffset))

  // ── Live-mode newest-turn-atomic policy ──
  //
  // At live (scrollLineOffset === 0), naive "take the last budgetLines
  // lines of the whole transcript" slices the NEWEST item from the top
  // whenever it exceeds the budget. Real-machine QA caught this: a
  // multi-line user block posted at live could render with only its
  // tail visible, making the user believe their submission was lost.
  //
  // Fix: anchor the newest item as the visibility primitive.
  //   - If newest item fits the budget, include it in full and
  //     backfill older items from the top of the viewport (the
  //     first-visible older item is sliced from its TOP so the
  //     continuity with the newest item's first line is preserved).
  //   - If newest item alone exceeds the budget, show its FIRST
  //     `budgetLines` lines (top slice) — "I sent this long message"
  //     is more useful than "last 6 lines of my message" for a
  //     just-submitted turn.
  //
  // Non-live mode (user has scrolled) keeps the position-based slice
  // below so scroll gestures land exactly where the user aimed.
  if (clampedOffset === 0) {
    const lastIdx = items.length - 1
    const lastCost = lineCosts[lastIdx]!
    const lastItem = items[lastIdx]!
    const lastDisplayLines = displayLinesByItem[lastIdx]!

    if (lastCost >= budgetLines) {
      // Newest item ≥ budget: top-slice it, hide all older items.
      const topLines = lastDisplayLines.slice(0, budgetLines)
      const topVisible: TranscriptItem = budgetLines === lastCost
        ? { id: lastItem.id, text: topLines.join('\n') }
        : { id: `${lastItem.id}::0-${budgetLines}`, text: topLines.join('\n') }
      // Report the viewport as covering [lastItemStart, lastItemStart + budgetLines)
      // so the scroll indicator shows the user is anchored at the top
      // of the newest item (not the overall transcript's bottom).
      let cumulative = 0
      for (let i = 0; i < lastIdx; i++) cumulative += lineCosts[i]!
      return {
        visible: [topVisible],
        totalLines,
        viewStartLine: cumulative,
        viewEndLine: cumulative + budgetLines,
        hiddenAboveCount: lastIdx,
        hiddenBelowCount: 0,
        clampedOffset,
        maxScrollOffset,
      }
    }

    // Newest item fits: include whole, backfill older items from
    // bottom upward. The first-visible older item is TOP-sliced
    // (we keep its tail — the lines chronologically adjacent to
    // the newest item's first line) so reading flows naturally.
    const liveVisible: TranscriptItem[] = [{ id: lastItem.id, text: lastDisplayLines.join('\n') }]
    let remaining = budgetLines - lastCost
    let cursor = lastIdx - 1
    while (cursor >= 0 && remaining > 0) {
      const cost = lineCosts[cursor]!
      if (cost <= remaining) {
        liveVisible.unshift({ id: items[cursor]!.id, text: displayLinesByItem[cursor]!.join('\n') })
        remaining -= cost
        cursor--
      } else {
        // Partial slice: take the BOTTOM `remaining` lines of the
        // older item (its tail) — those are chronologically closest
        // to the newest item and preserve reading continuity.
        const dl = displayLinesByItem[cursor]!
        const sliceStart = dl.length - remaining
        liveVisible.unshift({
          id: `${items[cursor]!.id}::${sliceStart}-${dl.length}`,
          text: dl.slice(sliceStart).join('\n'),
        })
        remaining = 0
        cursor--
        break
      }
    }
    const hiddenAbove = cursor + 1
    const viewEndLineLive = totalLines
    const viewStartLineLive = viewEndLineLive - (budgetLines - remaining)
    return {
      visible: liveVisible,
      totalLines,
      viewStartLine: viewStartLineLive,
      viewEndLine: viewEndLineLive,
      hiddenAboveCount: hiddenAbove,
      hiddenBelowCount: 0,
      clampedOffset,
      maxScrollOffset,
    }
  }

  // ── Non-live (scrolled): position-based slice ──
  // Scroll offset is the user's explicit anchor; slicing mid-item at
  // top or bottom is expected (they scrolled to exactly that line).

  // Calculate viewport window in line-space
  // scrollLineOffset=0 means "live" (viewing the bottom)
  const viewEndLine = totalLines - clampedOffset
  const viewStartLine = Math.max(0, viewEndLine - budgetLines)

  // Select exact content that overlaps the viewport [viewStartLine, viewEndLine).
  // Partial-item overlap must be sliced to the matching display lines; otherwise
  // the scrollbar can move while the user keeps seeing the same oversized item.
  let cumLines = 0
  const visible: TranscriptItem[] = []
  let hiddenAboveCount = 0
  let hiddenBelowCount = 0
  for (let i = 0; i < items.length; i++) {
    const itemStart = cumLines
    const itemEnd = cumLines + lineCosts[i]!
    if (itemEnd <= viewStartLine) {
      hiddenAboveCount++
    } else if (itemStart >= viewEndLine) {
      hiddenBelowCount++
    } else {
      const displayLines = displayLinesByItem[i]!
      const overlapStart = Math.max(0, viewStartLine - itemStart)
      const overlapEnd = Math.min(displayLines.length, viewEndLine - itemStart)
      const visibleText = displayLines.slice(overlapStart, overlapEnd).join('\n')
      visible.push({
        id: overlapStart === 0 && overlapEnd === displayLines.length
          ? items[i]!.id
          : `${items[i]!.id}::${overlapStart}-${overlapEnd}`,
        text: visibleText,
      })
    }
    cumLines += lineCosts[i]!
  }

  // Ensure at least one item is visible (even if it exceeds budget)
  if (visible.length === 0 && items.length > 0) {
    // Find the item closest to viewStartLine
    cumLines = 0
    for (let i = 0; i < items.length; i++) {
      const itemEnd = cumLines + lineCosts[i]!
      if (itemEnd > viewStartLine) {
        visible.push({
          id: items[i]!.id,
          text: displayLinesByItem[i]!.join('\n'),
        })
        break
      }
      cumLines += lineCosts[i]!
    }
  }

  return {
    visible,
    totalLines,
    viewStartLine,
    viewEndLine,
    hiddenAboveCount,
    hiddenBelowCount,
    clampedOffset,
    maxScrollOffset,
  }
}

// ─── Transcript scrollback split ───────────────────────────────────
//
// Split an append-only transcript item array into scrollback (committed
// to terminal-native scrollback via <Static>) + visible (rendered in the
// app's dynamic viewport via ScrollableTranscript).
//
// Window is the visible-item budget. Older items beyond that budget
// fall off the end of the visible window and become scrollback. Since
// the transcript is append-only, the split is always "first N go to
// scrollback, last window go to visible" — no mid-array surgery.
//
// Guards against non-positive window sizes by clamping to 1; this
// preserves at least one visible item so the app never goes fully
// blank even under pathological inputs (user / caller error).

export interface SplitTranscriptResult<T> {
  scrollback: T[]
  visible: T[]
}

export function splitTranscriptForScrollback<T>(
  items: readonly T[],
  window: number,
): SplitTranscriptResult<T> {
  const effectiveWindow = Math.max(1, window | 0)
  if (items.length === 0) return { scrollback: [], visible: [] }
  if (items.length <= effectiveWindow) {
    return { scrollback: [], visible: [...items] }
  }
  const cutoff = items.length - effectiveWindow
  return {
    scrollback: items.slice(0, cutoff),
    visible: items.slice(cutoff),
  }
}
