import { createHash } from 'node:crypto'
import { recordGateEvent, type GateEvent, type FidelityAnchorType, type FidelityEvidenceOrigin } from './gate-telemetry.js'
import type { AnthropicContentBlock, AnthropicTextBlock, AnthropicToolUseBlock, Conversation } from './protocol/types.js'

interface ClaimAnchor {
  anchorType: FidelityAnchorType
  target: string
  surface: string
  start: number
}

interface EvidenceSource {
  origin: FidelityEvidenceOrigin
  text: string
  turnIndex: number
}

export interface BuildClaimFidelityEventsOptions {
  conversationId: string
  iteration: number
  lastToolSignatures?: string[]
  model?: string
  phase?: string
  maxClaims?: number
}

const CLAIM_FIDELITY_MAX_CLAIMS = 24
const CLAIM_ANCHOR_TOKEN_CHAR = /[A-Za-z0-9._~+:/@%-]/
const PATH_RE = /(?:^|[^\w./@%+-])((?:\.{1,2}\/|\/)?[A-Za-z0-9_@.+%-]+(?:\/[A-Za-z0-9_@.+%-]+)+)(?=$|[^\w./@%+-])/g
const LINE_REF_RE = /(?:^|[^\w./@%+-])((?:\.{1,2}\/|\/)?[A-Za-z0-9_@.+%-]+(?:\/[A-Za-z0-9_@.+%-]+)+:\d+(?:-\d+)?)(?=$|[^\w./@%+-])/g
const HASH_RE = /\b[0-9a-f]{7,40}\b/gi
const FILENAME_RE = /\b[A-Za-z0-9_@.+%-]+\.(?:ts|tsx|js|jsx|json|md|yaml|yml|toml|lock|sh|py|rs|go)\b/g
const INLINE_CODE_RE = /`([^`\n]{2,180})`/g
const COMMAND_PREFIX_RE = /^(?:npm|pnpm|yarn|npx|node|git|rg|grep|find|vitest|tsc|tsx|perl|python|python3)\b/
const FILE_EXTENSION_RE = /\.(?:ts|tsx|js|jsx|json|md|yaml|yml|toml|lock|sh|py|rs|go)$/i
const KNOWN_PATH_ROOTS = new Set([
  'src',
  'test',
  'tests',
  'docs',
  'scripts',
  'bin',
  'lib',
  'libs',
  'app',
  'apps',
  'packages',
  'config',
  'configs',
  'tmp',
  'memory',
  '.owlcoda',
])
const PLACEHOLDER_PATH_SEGMENTS = new Set(['foo', 'bar', 'baz', 'qux', 'example', 'yourfile'])
const GENERIC_BASENAMES = new Set(['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'main.ts', 'main.js'])

export function buildClaimFidelityEvents(
  assistantText: string,
  conversation: Conversation,
  opts: BuildClaimFidelityEventsOptions,
): GateEvent[] {
  const anchors = extractClaimAnchors(assistantText).slice(0, opts.maxClaims ?? CLAIM_FIDELITY_MAX_CLAIMS)
  if (anchors.length === 0) return []

  const evidence = buildEvidenceSources(conversation)
  const currentTurnIndex = conversation.turns.length

  return anchors.map((anchor, index): GateEvent => {
    const match = findEvidenceMatch(anchor, evidence)
    return {
      ts: Date.now(),
      kind: 'fidelity_claim_observed',
      conversationId: opts.conversationId,
      iteration: opts.iteration,
      lastToolSignatures: opts.lastToolSignatures ?? [],
      claimId: claimIdFor(anchor, opts.iteration, index),
      surface: anchor.surface,
      anchorType: anchor.anchorType,
      target: anchor.target,
      evidenceOrigin: match?.origin ?? 'unknown',
      matched: match !== undefined,
      ageTurns: match ? Math.max(0, currentTurnIndex - match.turnIndex) : undefined,
      model: opts.model,
      phase: opts.phase,
    }
  })
}

export function recordClaimFidelityTelemetry(
  assistantText: string,
  conversation: Conversation,
  opts: BuildClaimFidelityEventsOptions,
): void {
  const events = buildClaimFidelityEvents(assistantText, conversation, opts)
  for (const event of events) recordGateEvent(event)
}

function extractClaimAnchors(text: string): ClaimAnchor[] {
  const anchors: ClaimAnchor[] = []
  const seen = new Set<string>()

  addRegexAnchors(text, LINE_REF_RE, 'line_ref', anchors, seen)
  addRegexAnchors(text, PATH_RE, 'path', anchors, seen)
  addInlineCommandAnchors(text, anchors, seen)
  addRegexAnchors(text, HASH_RE, 'commit_hash', anchors, seen)
  addFilenameAnchors(text, anchors, seen)

  return anchors.sort((a, b) => a.start - b.start)
}

function addRegexAnchors(
  text: string,
  regex: RegExp,
  anchorType: FidelityAnchorType,
  anchors: ClaimAnchor[],
  seen: Set<string>,
): void {
  regex.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const rawTarget = (match[1] ?? match[0]).trim()
    const target = normalizeAnchorTarget(rawTarget, anchorType)
    const start = match.index + match[0].indexOf(rawTarget)
    addAnchor(text, target, anchorType, start, anchors, seen)
  }
}

function addInlineCommandAnchors(
  text: string,
  anchors: ClaimAnchor[],
  seen: Set<string>,
): void {
  INLINE_CODE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = INLINE_CODE_RE.exec(text)) !== null) {
    const target = (match[1] ?? '').trim()
    if (!COMMAND_PREFIX_RE.test(target)) continue
    addAnchor(text, target, 'command', match.index + 1, anchors, seen)
  }
}

function addFilenameAnchors(
  text: string,
  anchors: ClaimAnchor[],
  seen: Set<string>,
): void {
  FILENAME_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FILENAME_RE.exec(text)) !== null) {
    const target = match[0].trim()
    const before = match.index > 0 ? text[match.index - 1] : ''
    if (before === '/') continue
    addAnchor(text, target, 'filename', match.index, anchors, seen)
  }
}

function addAnchor(
  text: string,
  target: string,
  anchorType: FidelityAnchorType,
  start: number,
  anchors: ClaimAnchor[],
  seen: Set<string>,
): void {
  if (target.length < 3 || target.length > 220) return
  if (!shouldKeepAnchor(target, anchorType)) return
  const key = anchorDedupeKey(target, anchorType)
  if (seen.has(key)) return
  seen.add(key)
  anchors.push({
    anchorType,
    target,
    surface: snippetAround(text, start, target.length),
    start,
  })
}

function normalizeAnchorTarget(target: string, anchorType: FidelityAnchorType): string {
  if (anchorType === 'path' || anchorType === 'filename' || anchorType === 'line_ref') {
    return target.replace(/[.,;!?]+$/g, '')
  }
  return target
}

function shouldKeepAnchor(target: string, anchorType: FidelityAnchorType): boolean {
  if (anchorType !== 'path' && anchorType !== 'filename' && anchorType !== 'line_ref') {
    return true
  }
  if (hasPlaceholderPathSegment(target)) return false
  if (anchorType === 'filename') return true
  return isAllowedPathTarget(target)
}

function isAllowedPathTarget(target: string): boolean {
  const fileTarget = fileTargetFromAnchor(target)
  if (/^\d+\/\d+$/.test(fileTarget)) return false
  if (FILE_EXTENSION_RE.test(lastPathSegment(fileTarget))) return true
  if (fileTarget.startsWith('./') || fileTarget.startsWith('../') || fileTarget.startsWith('/')) return true
  const first = pathSegments(fileTarget)[0]?.toLowerCase()
  return first !== undefined && KNOWN_PATH_ROOTS.has(first)
}

function hasPlaceholderPathSegment(target: string): boolean {
  return pathSegments(fileTargetFromAnchor(target)).some((segment) => {
    const base = stripKnownExtension(segment).toLowerCase()
    return PLACEHOLDER_PATH_SEGMENTS.has(base)
  })
}

function anchorDedupeKey(target: string, anchorType: FidelityAnchorType): string {
  if (anchorType === 'path' || anchorType === 'line_ref') {
    return `file:${fileTargetFromAnchor(target)}`
  }
  return `${anchorType}:${target}`
}

function buildEvidenceSources(conversation: Conversation): EvidenceSource[] {
  const sources: EvidenceSource[] = []
  const currentTurnIndex = conversation.turns.length

  if (conversation.options?.projectMapPromptSummary) {
    sources.push({
      origin: 'project_map',
      text: conversation.options.projectMapPromptSummary,
      turnIndex: currentTurnIndex,
    })
  }

  if (conversation.system) {
    sources.push({
      origin: 'instructions',
      text: conversation.system,
      turnIndex: 0,
    })
  }

  for (let i = 0; i < conversation.turns.length; i += 1) {
    const turn = conversation.turns[i]
    if (!turn) continue
    if (turn.role === 'assistant') {
      for (const block of turn.content) {
        if (block.type !== 'tool_use') continue
        const resultTurn = conversation.turns[i + 1]
        const hasMatchingResult = resultTurn?.role === 'user'
          && resultTurn.content.some((candidate) => (
            candidate.type === 'tool_result' && candidate.tool_use_id === block.id
          ))
        for (const text of toolUseEvidenceTexts(block)) {
          sources.push({
            origin: 'tool_call',
            text,
            turnIndex: hasMatchingResult ? i + 1 : i,
          })
        }
      }
    }

    const retainedText = textFromTurnContent(turn.content)
    if (!retainedText) continue
    const isCompactionSummary = retainedText.startsWith('[Conversation compacted:')
    if (!isCompactionSummary && turn.role !== 'assistant') continue
    sources.push({
      origin: isCompactionSummary ? 'compaction_summary' : 'retained_turn',
      text: retainedText,
      turnIndex: i,
    })
  }

  return sources
}

function toolUseEvidenceTexts(block: AnthropicToolUseBlock): string[] {
  const texts: string[] = [block.name]
  collectStringValues(block.input, texts)
  return texts
}

function collectStringValues(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed) out.push(trimmed)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStringValues(item, out)
    }
  }
}

function textFromTurnContent(content: AnthropicContentBlock[]): string {
  return content
    .filter((block): block is AnthropicTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function findEvidenceMatch(
  anchor: ClaimAnchor,
  evidence: EvidenceSource[],
): EvidenceSource | undefined {
  for (const source of evidence) {
    if (containsExactClaimAnchor(source.text, anchor.target)) return source
  }
  const basename = basenameForEvidenceMatch(anchor)
  if (!basename) return undefined
  for (const source of evidence) {
    if (containsBasenamePathSegment(source.text, basename)) return source
  }
  return undefined
}

export function containsExactClaimAnchor(text: string, target: string): boolean {
  let start = 0
  while (start < text.length) {
    const idx = text.indexOf(target, start)
    if (idx < 0) return false
    const before = idx > 0 ? text[idx - 1] : ''
    const after = text[idx + target.length] ?? ''
    if (
      !CLAIM_ANCHOR_TOKEN_CHAR.test(before)
      && !CLAIM_ANCHOR_TOKEN_CHAR.test(after)
    ) {
      return true
    }
    start = idx + target.length
  }
  return false
}

function basenameForEvidenceMatch(anchor: ClaimAnchor): string | undefined {
  if (anchor.anchorType !== 'filename' && anchor.anchorType !== 'path' && anchor.anchorType !== 'line_ref') {
    return undefined
  }
  const basename = lastPathSegment(fileTargetFromAnchor(anchor.target))
  if (!basename || GENERIC_BASENAMES.has(basename.toLowerCase())) return undefined
  return basename
}

function containsBasenamePathSegment(text: string, basename: string): boolean {
  let start = 0
  while (start < text.length) {
    const idx = text.indexOf(basename, start)
    if (idx < 0) return false
    const before = idx > 0 ? text[idx - 1] : ''
    const after = text[idx + basename.length] ?? ''
    if (
      (before === '/' || !CLAIM_ANCHOR_TOKEN_CHAR.test(before))
      && !CLAIM_ANCHOR_TOKEN_CHAR.test(after)
    ) {
      return true
    }
    start = idx + basename.length
  }
  return false
}

function fileTargetFromAnchor(target: string): string {
  return target.replace(/:\d+(?:-\d+)?$/g, '')
}

function pathSegments(target: string): string[] {
  return target.split('/').filter(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}

function lastPathSegment(target: string): string {
  const segments = pathSegments(target)
  return segments[segments.length - 1] ?? target
}

function stripKnownExtension(segment: string): string {
  return segment.replace(/\.(?:ts|tsx|js|jsx|json|md|yaml|yml|toml|lock|sh|py|rs|go)$/i, '')
}

function claimIdFor(anchor: ClaimAnchor, iteration: number, index: number): string {
  const hash = createHash('sha256')
    .update(anchor.anchorType)
    .update('\0')
    .update(anchor.target)
    .update('\0')
    .update(anchor.surface)
    .update('\0')
    .update(String(iteration))
    .update('\0')
    .update(String(index))
    .digest('hex')
    .slice(0, 12)
  return `claim:${hash}`
}

function snippetAround(text: string, start: number, length: number): string {
  const left = Math.max(0, start - 80)
  const right = Math.min(text.length, start + length + 80)
  return text.slice(left, right).replace(/\s+/g, ' ').trim()
}
