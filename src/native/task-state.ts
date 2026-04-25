import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, normalize, relative, resolve } from 'node:path'
import type {
  Conversation,
  TaskExecutionState,
  TaskPathScope,
} from './protocol/types.js'

const CONTINUATION_ONLY_RE = /^(?:继续|续跑|接着|继续一下|继续说|开始|继续吧|continue|resume|go on|carry on|go ahead|ok|okay|认可(?:了)?(?:，|,)?(?:开始|继续)?)\s*[.!。！]*$/i
const BACKTICK_PATH_RE = /`([^`\n]+)`/g
const GENERIC_PATH_RE = /(?:^|[\s(])((?:\/|\.\.?\/)?(?:[\w@~.-]+\/)+[\w@~.-]+(?:\.[\w.-]+)?\/?)(?=$|[\s),:;])/g
const SINGLE_FILE_RE = /(?:^|[\s(])((?:\/|\.\.?\/)?[\w@~.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|py|ipynb|rs|toml|yaml|yml|sh|txt|css|scss|html))(?=$|[\s),:;])/g
const MUTATING_WRITE_TOOLS = new Set(['write', 'edit', 'NotebookEdit'])
const BOOTSTRAP_SCOPE_FILE_EXTS = new Set(['.md', '.mdx', '.txt'])
const BOOTSTRAP_SCOPE_MAX_BYTES = 256 * 1024
const ALLOW_WRITE_SECTION_RE = /(允许写入|允许修改|可改动|allowed write|allowed files|allowed paths)/i
const FORBIDDEN_WRITE_SECTION_RE = /(禁止改动|禁止修改|禁止写入|forbidden|do not modify|do not edit|not allowed)/i
const WRITE_SCOPE_APPROVAL_RE = /\b(?:approve|approved|authorize|authorized|allow|allowed|permission granted|go ahead|yes|ok|okay|confirm|confirmed)\b|(?:批准|授权|允许|同意|确认|可以|准许|继续写|继续执行|放行|没问题|是的)/i
const WRITE_SCOPE_DENIAL_RE = /\b(?:deny|denied|no|nope|reject|rejected|do not|don't|stop)\b|(?:不行|不要|拒绝|禁止|停止|别写|不能写)/i

export interface WriteGuardViolation {
  attemptedPath: string
  allowedPaths: string[]
  message: string
}

interface SubstantiveUserInput {
  rawText: string
  normalizedText: string
}

export function ensureTaskExecutionState(
  conversation: Conversation,
  cwd = process.cwd(),
): TaskExecutionState {
  const canonicalCwd = canonicalizePath(cwd)
  const existing = conversation.options?.taskState
  const source = collectSubstantiveUserInputs(conversation)
  const sourceText = source.map((entry) => entry.rawText).join('\n\n').trim()
  const sourceTurnHash = stableHash(`${normalizeWhitespace(sourceText)}|${canonicalCwd}`)
  if (
    existing
    && existing.contract.sourceTurnHash === sourceTurnHash
    && canonicalizePath(existing.contract.cwd) === canonicalCwd
  ) {
    return existing
  }

  const next = deriveTaskExecutionState(conversation, canonicalCwd, existing)
  conversation.options = conversation.options ?? {}
  conversation.options.taskState = next
  return next
}

export function deriveTaskExecutionState(
  conversation: Conversation,
  cwd = process.cwd(),
  previous?: TaskExecutionState,
): TaskExecutionState {
  const canonicalCwd = canonicalizePath(cwd)
  const source = collectSubstantiveUserInputs(conversation)
  const sourceText = source.map((entry) => entry.rawText).join('\n\n').trim()
  const objective = source.at(-1)?.rawText
    ?? latestUserText(conversation)
    ?? 'Complete the current user-requested task.'
  const sourceTurnHash = stableHash(`${normalizeWhitespace(sourceText || objective)}|${canonicalCwd}`)
  const latestInput = source.at(-1)
  const approvesPendingWriteScope = Boolean(previous && latestInput && isWriteScopeApprovalInput(latestInput.normalizedText))
  const previousPendingPaths = previous?.run.pendingWriteApproval?.attemptedPaths ?? []
  const explicitWriteTargets = dedupeStrings([
    ...collectExplicitWriteTargets(source, canonicalCwd),
    ...(approvesPendingWriteScope ? previousPendingPaths : []),
  ])
  const allowedWritePaths = deriveAllowedWritePaths(explicitWriteTargets, canonicalCwd, previous?.contract.touchedPaths ?? [])
  const now = Date.now()

  return {
    contract: {
      version: 1,
      sourceTurnHash,
      sourceText: sourceText || objective,
      objective: approvesPendingWriteScope
        ? previous?.contract.objective ?? objective
        : objective,
      dominantGap: previous?.contract.dominantGap ?? null,
      cwd: canonicalCwd,
      scopeMode: explicitWriteTargets.length > 0 ? 'explicit_paths' : 'workspace',
      explicitWriteTargets,
      allowedWritePaths,
      touchedPaths: dedupeStrings(previous?.contract.touchedPaths ?? []),
      createdAt: previous?.contract.createdAt ?? now,
      updatedAt: now,
    },
    run: {
      status: approvesPendingWriteScope ? 'open' : previous?.run.status ?? 'open',
      iterations: previous?.run.iterations ?? 0,
      currentFocus: previous?.run.currentFocus ?? null,
      lastProgressAt: previous?.run.lastProgressAt ?? now,
      lastGuardReason: approvesPendingWriteScope ? null : previous?.run.lastGuardReason ?? null,
      pendingWriteApproval: approvesPendingWriteScope ? null : previous?.run.pendingWriteApproval ?? null,
      lastUpdatedAt: now,
    },
  }
}

export function describeTaskExecutionState(taskState: TaskExecutionState): string {
  if (taskState.contract.scopeMode === 'workspace') {
    return 'Task contract: no explicit write scope inferred yet, so file writes remain limited to the workspace boundary.'
  }
  const preview = taskState.contract.allowedWritePaths
    .slice(0, 3)
    .map((scope) => scope.path)
    .join(', ')
  const extra = taskState.contract.allowedWritePaths.length > 3
    ? ` (+${taskState.contract.allowedWritePaths.length - 3} more)`
    : ''
  return `Task contract: write scope narrowed to ${taskState.contract.allowedWritePaths.length} task paths (${preview}${extra}).`
}

export function markTaskIteration(
  taskState: TaskExecutionState,
  details: { iterations: number; currentFocus?: string | null; dominantGap?: string | null },
): void {
  const now = Date.now()
  taskState.run.iterations = details.iterations
  taskState.run.currentFocus = details.currentFocus ?? taskState.run.currentFocus
  taskState.run.lastUpdatedAt = now
  if (details.dominantGap !== undefined) {
    taskState.contract.dominantGap = details.dominantGap
    taskState.contract.updatedAt = now
  }
}

export function markTaskProgress(taskState: TaskExecutionState, focus?: string | null): void {
  const now = Date.now()
  taskState.run.status = 'open'
  taskState.run.lastProgressAt = now
  taskState.run.lastUpdatedAt = now
  taskState.run.lastGuardReason = null
  if (focus !== undefined) taskState.run.currentFocus = focus
}

export function markTaskBlocked(taskState: TaskExecutionState, reason: string, focus?: string | null): void {
  const now = Date.now()
  taskState.run.status = 'blocked'
  taskState.run.lastGuardReason = reason
  taskState.run.lastUpdatedAt = now
  if (focus !== undefined) taskState.run.currentFocus = focus
}

export function markTaskGuardBlocked(taskState: TaskExecutionState, reason: string): void {
  const now = Date.now()
  taskState.run.status = 'drifted'
  taskState.run.lastGuardReason = reason
  taskState.run.lastUpdatedAt = now
}

export function markTaskWaitingUser(taskState: TaskExecutionState, reason: string): void {
  const now = Date.now()
  taskState.run.status = 'waiting_user'
  taskState.run.lastGuardReason = reason
  taskState.run.lastUpdatedAt = now
}

export function markTaskWriteScopeBlocked(
  taskState: TaskExecutionState,
  reason: string,
  attemptedPath: string,
): void {
  const now = Date.now()
  taskState.run.status = 'waiting_user'
  taskState.run.lastGuardReason = reason
  taskState.run.pendingWriteApproval = {
    attemptedPaths: dedupeStrings([
      ...(taskState.run.pendingWriteApproval?.attemptedPaths ?? []),
      attemptedPath,
    ]),
    requestedAt: now,
  }
  taskState.run.lastUpdatedAt = now
}

export function approveTaskWriteScope(taskState: TaskExecutionState, attemptedPath: string): boolean {
  const canonicalPath = canonicalizePath(attemptedPath)
  if (!isWithinRoot(canonicalPath, taskState.contract.cwd)) return false

  if (!taskState.contract.allowedWritePaths.some((scope) => pathMatchesScope(canonicalPath, scope))) {
    taskState.contract.allowedWritePaths.push({
      path: canonicalPath,
      kind: inferScopeKind(canonicalPath),
      origin: 'user_approved',
    })
  }

  taskState.run.pendingWriteApproval = taskState.run.pendingWriteApproval
    ? {
        ...taskState.run.pendingWriteApproval,
        attemptedPaths: taskState.run.pendingWriteApproval.attemptedPaths.filter((path) => path !== canonicalPath),
      }
    : null
  if (taskState.run.pendingWriteApproval && taskState.run.pendingWriteApproval.attemptedPaths.length === 0) {
    taskState.run.pendingWriteApproval = null
  }

  const now = Date.now()
  taskState.run.status = 'open'
  taskState.run.lastGuardReason = null
  taskState.run.lastUpdatedAt = now
  taskState.contract.allowedWritePaths = dedupeScopes(taskState.contract.allowedWritePaths)
  taskState.contract.updatedAt = now
  return true
}

export function markTaskCompleted(taskState: TaskExecutionState, summary?: string | null): void {
  const now = Date.now()
  taskState.run.status = 'completed'
  taskState.run.lastProgressAt = now
  taskState.run.lastUpdatedAt = now
  taskState.run.lastGuardReason = null
  taskState.run.pendingWriteApproval = null
  if (summary) {
    taskState.run.currentFocus = truncateForState(summary)
  }
}

export function shouldTreatTaskRunStatusAsFailure(
  status: TaskExecutionState['run']['status'] | null | undefined,
): boolean {
  return status === 'open'
    || status === 'blocked'
    || status === 'waiting_user'
    || status === 'drifted'
}

export function evaluateWriteGuard(
  toolName: string,
  input: Record<string, unknown>,
  taskState?: TaskExecutionState,
): WriteGuardViolation | null {
  if (!taskState) return null
  if (!isMutatingWriteTool(toolName)) return null
  const attemptedPath = extractWriteTargetPath(toolName, input, taskState.contract.cwd)
  if (!attemptedPath) return null

  if (taskState.contract.scopeMode !== 'explicit_paths') {
    return null
  }

  const allowedScopes = taskState.contract.allowedWritePaths
  if (allowedScopes.some((scope) => pathMatchesScope(attemptedPath, scope))) {
    return null
  }

  const allowedPaths = allowedScopes.map((scope) => scope.path)
  const summary = allowedPaths.slice(0, 4).join(', ')
  const more = allowedPaths.length > 4 ? ` (+${allowedPaths.length - 4} more)` : ''
  return {
    attemptedPath,
    allowedPaths,
    message:
      `Task contract blocked write to ${attemptedPath}. ` +
      `This task is currently scoped to: ${summary}${more}. ` +
      `Update the task contract with a new user instruction before editing outside that scope.`,
  }
}

export function recordWriteSuccess(
  taskState: TaskExecutionState | undefined,
  toolName: string,
  input: Record<string, unknown>,
  metadata?: Record<string, unknown>,
): void {
  if (!taskState) return
  if (!isMutatingWriteTool(toolName)) return
  const pathFromMetadata = typeof metadata?.['path'] === 'string'
    ? metadata['path']
    : typeof metadata?.['notebook_path'] === 'string'
      ? metadata['notebook_path']
      : null
  const attemptedPath = pathFromMetadata
    ?? extractWriteTargetPath(toolName, input, taskState.contract.cwd)
  if (!attemptedPath || !isWithinRoot(attemptedPath, taskState.contract.cwd)) return

  if (!taskState.contract.touchedPaths.includes(attemptedPath)) {
    taskState.contract.touchedPaths.push(attemptedPath)
  }
  if (!taskState.contract.allowedWritePaths.some(
    (scope) => scope.kind === 'file' && normalize(scope.path) === normalize(attemptedPath),
  )) {
    taskState.contract.allowedWritePaths.push({
      path: attemptedPath,
      kind: 'file',
      origin: 'touched',
    })
  }
  taskState.contract.touchedPaths = dedupeStrings(taskState.contract.touchedPaths)
  taskState.contract.allowedWritePaths = dedupeScopes(taskState.contract.allowedWritePaths)
  taskState.contract.updatedAt = Date.now()
  markTaskProgress(taskState)
}

export function buildTaskRealignPrompt(taskState: TaskExecutionState): string {
  const allowedScope = describeAllowedWriteScope(taskState)
  const dominantGap = taskState.contract.dominantGap ?? 'Re-center on the current objective before exploring anything else.'
  const guardReason = taskState.run.lastGuardReason ?? 'The last step drifted outside the current task contract.'
  const nextStep =
    taskState.run.status === 'waiting_user'
      ? 'Do not continue with blocked operations. Ask the user one concise question or explain the approval you need.'
      : 'Return to the objective. In your next response, either:\n1. write a short corrected plan in 1-3 sentences with no tool calls, or\n2. make only tool calls that stay within this contract.'
  return [
    '[Runtime task contract]',
    `Objective: ${taskState.contract.objective}`,
    `Dominant gap: ${dominantGap}`,
    `Current issue: ${guardReason}`,
    `Allowed write scope: ${allowedScope}`,
    nextStep,
    'Do not broaden the task, and do not edit files outside the allowed scope without asking the user first.',
  ].join('\n')
}

export function describeAllowedWriteScope(taskState: TaskExecutionState): string {
  if (taskState.contract.scopeMode !== 'explicit_paths') {
    return `workspace:${taskState.contract.cwd}`
  }
  const explicit = taskState.contract.allowedWritePaths
    .slice(0, 6)
    .map((scope) => scope.path)
  const extra = taskState.contract.allowedWritePaths.length - explicit.length
  return extra > 0
    ? `${explicit.join(', ')} (+${extra} more)`
    : explicit.join(', ')
}

export function buildTaskContinuePrompt(
  taskState: TaskExecutionState,
  latestAssistantText: string,
): string {
  const dominantGap = taskState.contract.dominantGap ?? 'Continue the next best step needed to finish the current objective.'
  const trimmedAssistantText = truncateForState(normalizeWhitespace(latestAssistantText), 200)
  return [
    '[Runtime continue-while-open]',
    `Objective: ${taskState.contract.objective}`,
    `Dominant gap: ${dominantGap}`,
    `Your last message looked like an interim progress update, not a finished task: ${trimmedAssistantText}`,
    'Continue the task now. Do not stop at another interim summary.',
    'Only stop if you have actually completed the task, need user input, or hit a concrete blocker.',
  ].join('\n')
}

function latestUserText(conversation: Conversation): string | null {
  for (let i = conversation.turns.length - 1; i >= 0; i--) {
    const turn = conversation.turns[i]
    if (!turn || turn.role !== 'user') continue
    const text = turn.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text) return text
  }
  return null
}

function collectSubstantiveUserInputs(conversation: Conversation): SubstantiveUserInput[] {
  const collected: SubstantiveUserInput[] = []
  for (const turn of conversation.turns) {
    if (turn.role !== 'user') continue
    const text = turn.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (!text) continue
    const normalizedText = normalizeWhitespace(text)
    if (CONTINUATION_ONLY_RE.test(normalizedText) && collected.length > 0) continue
    collected.push({ rawText: text, normalizedText })
  }
  return collected
}

function collectExplicitWriteTargets(source: SubstantiveUserInput[], cwd: string): string[] {
  const candidates = new Set<string>()
  for (const entry of source) {
    for (const candidate of extractPathCandidates(entry.rawText)) {
      const resolved = resolveCandidatePath(candidate, cwd)
      if (resolved) candidates.add(resolved)
    }
  }
  for (const candidate of extractBootstrapWriteTargets([...candidates], cwd)) {
    candidates.add(candidate)
  }
  return [...candidates]
}

function isWriteScopeApprovalInput(text: string): boolean {
  return WRITE_SCOPE_APPROVAL_RE.test(text) && !WRITE_SCOPE_DENIAL_RE.test(text)
}

function deriveAllowedWritePaths(
  explicitWriteTargets: string[],
  cwd: string,
  touchedPaths: string[],
): TaskPathScope[] {
  const scopes: TaskPathScope[] = []
  for (const target of explicitWriteTargets) {
    const explicitKind = inferScopeKind(target)
    scopes.push({ path: target, kind: explicitKind, origin: 'explicit' })

    if (explicitKind === 'file') {
      const parent = dirname(target)
      if (parent !== normalize(cwd)) {
        scopes.push({ path: parent, kind: 'directory', origin: 'parent_directory' })
      }
      scopes.push(...deriveCompanionTestScopes(target, cwd))
    }
  }

  for (const touchedPath of touchedPaths) {
    if (!isWithinRoot(touchedPath, cwd)) continue
    scopes.push({ path: touchedPath, kind: 'file', origin: 'touched' })
  }

  return dedupeScopes(scopes)
}

function deriveCompanionTestScopes(target: string, cwd: string): TaskPathScope[] {
  const rel = relative(cwd, target).replaceAll('\\', '/')
  if (!rel.startsWith('src/')) return []
  const srcTail = rel.slice(4)
  const fileExt = extname(srcTail)
  if (!fileExt) return []

  const fileBase = basename(srcTail, fileExt)
  const parent = dirname(srcTail)
  const testDir = resolve(cwd, 'tests', parent === '.' ? '' : parent)
  const scopes: TaskPathScope[] = [
    { path: testDir, kind: 'directory', origin: 'derived_test' },
    { path: resolve(testDir, `${fileBase}.test${fileExt}`), kind: 'file', origin: 'derived_test' },
    { path: resolve(testDir, `${fileBase}.spec${fileExt}`), kind: 'file', origin: 'derived_test' },
  ]
  return scopes
}

function extractPathCandidates(text: string): string[] {
  const matches = new Set<string>()
  for (const match of text.matchAll(BACKTICK_PATH_RE)) {
    const candidate = match[1]?.trim()
    if (candidate && isLikelyPathCandidate(candidate)) matches.add(candidate)
  }
  for (const match of text.matchAll(GENERIC_PATH_RE)) {
    const candidate = match[1]?.trim()
    if (candidate) matches.add(candidate)
  }
  for (const match of text.matchAll(SINGLE_FILE_RE)) {
    const candidate = match[1]?.trim()
    if (candidate) matches.add(candidate)
  }
  return [...matches]
}

function isLikelyPathCandidate(candidate: string): boolean {
  return candidate.startsWith('/')
    || candidate.startsWith('./')
    || candidate.startsWith('../')
    || candidate.endsWith('/')
    || candidate.includes('/')
    || extname(candidate) !== ''
}

function resolveCandidatePath(candidate: string, cwd: string): string | null {
  const cleaned = candidate
    .replace(/^['"`]+/, '')
    .replace(/['"`),.;:]+$/, '')
    .trim()
  if (!cleaned || cleaned.includes('://')) return null
  const resolved = isAbsolute(cleaned)
    ? resolve(cleaned)
    : resolve(cwd, cleaned)
  if (!isWithinRoot(resolved, cwd)) return null
  return canonicalizePath(resolved)
}

function inferScopeKind(pathToCheck: string): 'file' | 'directory' {
  if (pathToCheck.endsWith('/')) return 'directory'
  if (existsSync(pathToCheck)) {
    try {
      return statSync(pathToCheck).isDirectory() ? 'directory' : 'file'
    } catch {
      return 'file'
    }
  }
  return extname(pathToCheck) ? 'file' : 'directory'
}

function extractWriteTargetPath(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): string | null {
  const rawPath = toolName === 'NotebookEdit'
    ? input['notebook_path']
    : input['path']
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null
  const resolved = isAbsolute(rawPath)
    ? resolve(rawPath)
    : resolve(cwd, rawPath)
  return canonicalizePath(resolved)
}

function isMutatingWriteTool(toolName: string): boolean {
  return MUTATING_WRITE_TOOLS.has(toolName)
}

function extractBootstrapWriteTargets(explicitTargets: string[], cwd: string): string[] {
  const candidates = new Set<string>()
  for (const target of explicitTargets) {
    if (!shouldBootstrapScopeFromFile(target)) continue
    const content = safeReadBootstrapFile(target)
    if (!content) continue
    for (const candidate of extractAllowedPathsFromBootstrapText(content)) {
      const resolved = resolveCandidatePath(candidate, cwd)
      if (resolved) candidates.add(resolved)
    }
  }
  return [...candidates]
}

function shouldBootstrapScopeFromFile(pathToCheck: string): boolean {
  if (inferScopeKind(pathToCheck) !== 'file') return false
  return BOOTSTRAP_SCOPE_FILE_EXTS.has(extname(pathToCheck).toLowerCase())
}

function safeReadBootstrapFile(pathToCheck: string): string | null {
  try {
    const stats = statSync(pathToCheck)
    if (!stats.isFile() || stats.size > BOOTSTRAP_SCOPE_MAX_BYTES) {
      return null
    }
    return readFileSync(pathToCheck, 'utf8')
  } catch {
    return null
  }
}

function extractAllowedPathsFromBootstrapText(text: string): string[] {
  const candidates = new Set<string>()
  let inAllowSection = false

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (isAllowSectionHeading(trimmed)) {
      inAllowSection = true
      continue
    }

    if (isForbiddenSectionHeading(trimmed)) {
      inAllowSection = false
      continue
    }

    if (inAllowSection && isOtherSectionHeading(trimmed)) {
      inAllowSection = false
      continue
    }

    if (!inAllowSection) continue

    for (const candidate of extractPathCandidates(trimmed)) {
      candidates.add(candidate)
    }
  }

  return [...candidates]
}

function isAllowSectionHeading(line: string): boolean {
  return !lineHasConcretePath(line) && ALLOW_WRITE_SECTION_RE.test(line)
}

function isForbiddenSectionHeading(line: string): boolean {
  return !lineHasConcretePath(line) && FORBIDDEN_WRITE_SECTION_RE.test(line)
}

function isOtherSectionHeading(line: string): boolean {
  if (lineHasConcretePath(line)) return false
  return line.startsWith('#')
    || /^[-*]\s*`[^`]+`[:：]?$/.test(line)
    || /^[-*]\s*\*\*[^*]+\*\*[:：]?$/.test(line)
    || /^##\s+/.test(line)
}

function lineHasConcretePath(line: string): boolean {
  return extractPathCandidates(line).length > 0
}

function pathMatchesScope(candidatePath: string, scope: TaskPathScope): boolean {
  const normalizedCandidate = canonicalizePath(candidatePath)
  const normalizedScope = canonicalizePath(scope.path)
  if (scope.kind === 'file') {
    return normalizedCandidate === normalizedScope
  }
  return normalizedCandidate === normalizedScope
    || normalizedCandidate.startsWith(`${normalizedScope}/`)
}

function isWithinRoot(candidatePath: string, root: string): boolean {
  const normalizedCandidate = canonicalizePath(candidatePath)
  const normalizedRoot = canonicalizePath(root)
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}/`)
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function stableHash(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => canonicalizePath(value)))]
}

function dedupeScopes(scopes: TaskPathScope[]): TaskPathScope[] {
  const byKey = new Map<string, TaskPathScope>()
  for (const scope of scopes) {
    const canonicalScopePath = canonicalizePath(scope.path)
    byKey.set(`${scope.kind}:${canonicalScopePath}`, {
      ...scope,
      path: canonicalScopePath,
    })
  }
  return [...byKey.values()]
}

function canonicalizePath(pathToCheck: string): string {
  const resolved = resolve(pathToCheck)
  try {
    return normalize(realpathSync.native(resolved))
  } catch {
    const parent = dirname(resolved)
    if (parent === resolved) return normalize(resolved)
    const canonicalParent = canonicalizePath(parent)
    return normalize(resolve(canonicalParent, basename(resolved)))
  }
}

function truncateForState(text: string, maxChars = 160): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}
