import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, normalize, relative, resolve } from 'node:path'
import { classifyDeliverableContract } from './deliverable-contract.js'
import type {
  Conversation,
  TaskContractScopeConfidence,
  TaskExecutionState,
  TaskPathScope,
  TaskPathScopeOrigin,
} from './protocol/types.js'
import { checkWritePathAllowed } from './tools/fs-policy.js'
import { classifyBashCommand } from './bash-risk.js'
import { createRunWorkspace, recordArtifact, type TaskFamily } from './run-workspace.js'
import {
  admit as admitProvenanceRecord,
  cloneProvenanceLedgerData,
  createEmptyProvenanceLedgerData,
  extractPathsFromUserMessage,
} from './write-provenance.js'
import { loadResolvedPermissions } from './permission-rules.js'
import { canonicalToolName } from './tool-defs.js'
import type { ProvenanceLedgerData, ProvenanceRecord, UserPathExtraction } from './protocol/write-provenance-types.js'
import type { ResolvedPermissions } from './protocol/permission-rule-types.js'

const CONTINUATION_ONLY_RE = /^(?:继续|续跑|接着|继续一下|继续说|开始|继续吧|continue|resume|go on|carry on|go ahead|ok|okay|认可(?:了)?(?:，|,)?(?:开始|继续)?)\s*[.!。！]*$/i
const TASK_STATUS_CHECK_RE = /^(?:你)?(?:一直)?(?:在)?(?:忙活|忙|做)(?:了)?什么[？?。!！]*$|^(?:刚刚)?(?:不是)?一直说.+(?:不过|失败)[？?。!！]*$|^(?:目前|现在|当前).{0,60}(?:进度|输出了|完成了多少|在做)/i
const BACKTICK_PATH_RE = /`([^`\n]+)`/g
const GENERIC_PATH_RE = /(?:^|[\s(])((?:\/|\.\.?\/)?(?:[\w@~.-]+\/)+[\w@~.-]+(?:\.[\w.-]+)?\/?)(?=$|[\s),:;])/g
const SINGLE_FILE_RE = /(?:^|[\s(])((?:\/|\.\.?\/)?[\w@~.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|py|ipynb|rs|toml|yaml|yml|sh|txt|css|scss|html))(?=$|[\s),:;])/g
const MUTATING_WRITE_TOOLS = new Set(['write', 'edit', 'NotebookEdit'])
const SHELL_ARTIFACT_TOOLS = new Set(['bash', 'PowerShell'])
const EXECUTION_PROGRESS_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskVerify', 'RunWorkspace', 'ArtifactVerify'])
const BOOTSTRAP_SCOPE_FILE_EXTS = new Set(['.md', '.mdx', '.txt'])
const BOOTSTRAP_SCOPE_MAX_BYTES = 256 * 1024
const ALLOW_WRITE_SECTION_RE = /(允许写入|允许修改|可改动|allowed write|allowed files|allowed paths)/i
const FORBIDDEN_WRITE_SECTION_RE = /(禁止改动|禁止修改|禁止写入|forbidden|do not modify|do not edit|not allowed)/i
const FORBIDDEN_INLINE_WRITE_SECTION_RE = /^(?:[#>*\-\s]*|【)?(?:禁止|严禁|不得|不允许|禁止改动|禁止修改|禁止写入|forbidden|do not modify|do not edit|not allowed)(?:】)?[:：]?\s*$/i
const ALLOW_INLINE_WRITE_TARGET_RE = /(?:只许|只允许|只能|允许|可(?:以)?|输出|allowed|only|output)[^。！？\n.!?]{0,80}(?:写|写入|写到|修改|改动|保存|落盘|输出到|write|edit|modify|save|output)|(?:输出到|保存到|落盘到|写到|写入到|生成到|导出到|output\s+to|save\s+to|write\s+to|export\s+to|generate\s+to)|\b(?:write|save|output|export|generate|create)\b[^。！？\n.!?]{0,100}\b(?:to|into|at)\b|(?:生成|创建|导出)[^。！？\n.!?]{0,100}(?:到|至)/i
const FORBIDDEN_INLINE_WRITE_TARGET_RE = /(?:只读|禁止|严禁|不(?:允许|能|要|得|可)|不能|不要|不得|无需|无须|不用)[^。！？\n.!?]{0,120}(?:写|改|修改|更新|补|新增|实现|修复|创建|生成|删除|落盘|切到|切换到|切换|改用|write|edit|modify|update|patch|create|delete|remove|touch|switch\s+to|switch\s+over\s+to)|\b(?:read[- ]?only|no\s+mutations?|no\s+writes?|do\s+not|don't|never|must\s+not|not\s+allowed\s+to|forbidden|without)\b[^。！？\n.!?]{0,120}\b(?:write|edit|modify|update|patch|create|delete|remove|touch|writing|editing|modifying|updating|patching|creating|deleting|removing)\b|\b(?:do\s+not|don't|never|must\s+not|not\s+allowed\s+to|forbidden)\b[^。！？\n.!?]{0,120}\b(?:switch(?:\s+over)?\s+to)\b/i
const SUGGESTED_FILENAME_RE = /(?:建议文件名|推荐文件名|suggested\s+file\s*name|recommended\s+file\s*name)/i
const WRITE_SCOPE_APPROVAL_RE = /\b(?:approve|approved|authorize|authorized|allow|allowed|permission granted|go ahead|yes|ok|okay|confirm|confirmed)\b|(?:批准|授权|允许|同意|确认|可以|准许|继续写|继续执行|放行|没问题|是的)/i
const WRITE_SCOPE_DENIAL_RE = /\b(?:deny|denied|no|nope|reject|rejected|do not|don't|stop)\b|(?:不行|不要|拒绝|禁止|停止|别写|不能写)/i
const PROJECT_PATH_PREFIX_RE = /^(?:src|tests?|docs?|admin|site|scripts?|assets?|examples?|internal|dist|config|\.github|\.claude)\//

export interface WriteGuardViolation {
  attemptedPath: string
  attemptedPaths: string[]
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
  const latestControlInput = latestUserInputForTaskControl(conversation)
  const shouldConsumePendingApproval = Boolean(
    existing?.run.pendingWriteApproval
    && latestControlInput
    && isWriteScopeApprovalInput(latestControlInput.normalizedText),
  )
  if (
    existing
    && existing.contract.sourceTurnHash === sourceTurnHash
    && canonicalizePath(existing.contract.cwd) === canonicalCwd
    && !shouldConsumePendingApproval
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
  const sameTaskAsPrevious = Boolean(
    previous
    && previous.contract.sourceTurnHash === sourceTurnHash
    && canonicalizePath(previous.contract.cwd) === canonicalCwd,
  )
  const latestInput = source.at(-1)
  const latestControlInput = latestUserInputForTaskControl(conversation)
  const approvesPendingWriteScope = Boolean(previous && latestControlInput && isWriteScopeApprovalInput(latestControlInput.normalizedText))
  const previousPendingPaths = previous?.run.pendingWriteApproval?.attemptedPaths ?? []
  const explicitResult = collectExplicitWriteTargets(source, canonicalCwd)
  const explicitWriteTargets = dedupeStrings([
    ...explicitResult.allTargets,
    ...(approvesPendingWriteScope ? previousPendingPaths : []),
  ])
  const allowedWritePaths = deriveAllowedWritePaths(explicitWriteTargets, canonicalCwd, previous?.contract.touchedPaths ?? [], explicitResult.userExternalTargets)
  const scopeMode = explicitWriteTargets.length > 0 ? 'explicit_paths' : 'workspace'
  const confidence = deriveScopeConfidence(scopeMode, allowedWritePaths, canonicalCwd)
  const now = Date.now()
  const provenanceLedger = deriveProvenanceLedgerData({
    source,
    cwd: canonicalCwd,
    previous,
    sameTaskAsPrevious,
    now,
  })
  // PERM-6: load settings.json permission rules. Re-loaded on every task
  // state derivation so users who edit ~/.owlcoda/settings.json or
  // .owlcoda/settings.json mid-conversation see changes on the next task.
  // Loader is filesystem-bound; misuse (eg. running test scenarios under
  // a user with broken settings) is bounded by ENOENT being silent.
  const resolvedPermissions: ResolvedPermissions = loadResolvedPermissions({
    projectRoot: canonicalCwd,
  })

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
      scopeMode,
      explicitWriteTargets,
      allowedWritePaths,
      touchedPaths: dedupeStrings(previous?.contract.touchedPaths ?? []),
      createdAt: previous?.contract.createdAt ?? now,
      updatedAt: now,
      confidence,
    },
    run: {
      status: approvesPendingWriteScope ? 'open' : previous?.run.status ?? 'open',
      iterations: previous?.run.iterations ?? 0,
      lifetimeIterations: previous?.run.lifetimeIterations ?? 0,
      productionGateFired: previous?.run.productionGateFired ?? false,
      noProgressAdvisoryFired: previous?.run.noProgressAdvisoryFired ?? false,
      editNowNudgedGrantTs: sameTaskAsPrevious ? (previous?.run.editNowNudgedGrantTs ?? []) : [],
      // editNowNudgePending is transient (consumed inside one iteration); always undefined here.
      scratchArtifactPaths: dedupeStrings(previous?.run.scratchArtifactPaths ?? []),
      lastArtifactProgressIteration: previous?.run.lastArtifactProgressIteration,
      currentFocus: previous?.run.currentFocus ?? null,
      lastProgressAt: previous?.run.lastProgressAt ?? now,
      lastGuardReason: approvesPendingWriteScope ? null : previous?.run.lastGuardReason ?? null,
      pendingWriteApproval: approvesPendingWriteScope ? null : previous?.run.pendingWriteApproval ?? null,
      runWorkspace: sameTaskAsPrevious ? previous?.run.runWorkspace ?? null : null,
      lastUpdatedAt: now,
    },
    proposedToolCalls: sameTaskAsPrevious ? (previous?.proposedToolCalls ?? []) : [],
    phaseEvents: sameTaskAsPrevious ? (previous?.phaseEvents ?? []) : [],
    provenanceLedger,
    resolvedPermissions,
  }
}

function deriveProvenanceLedgerData(options: {
  source: SubstantiveUserInput[]
  cwd: string
  previous?: TaskExecutionState
  sameTaskAsPrevious: boolean
  now: number
}): ProvenanceLedgerData {
  const ledger = options.sameTaskAsPrevious && options.previous?.provenanceLedger
    ? cloneProvenanceLedgerData(options.previous.provenanceLedger)
    : createEmptyProvenanceLedgerData()

  options.source.forEach((entry, index) => {
    const extraction = extractPathsFromUserMessage(entry.rawText, {
      cwd: options.cwd,
      ts: options.now + index,
      originIteration: index,
    })
    for (const item of extraction.extractions) {
      admitProvenanceRecord(ledger, item.path, provenanceRecordFromUserExtraction(item, options.now + index, index))
    }
  })

  return ledger
}

function provenanceRecordFromUserExtraction(
  extraction: UserPathExtraction,
  ts: number,
  originIteration: number,
): ProvenanceRecord {
  return {
    kind: extraction.kind,
    ts,
    originIteration,
    originalString: extraction.originalString,
    ...(extraction.verbContext ? { verbContext: extraction.verbContext } : {}),
    ...(extraction.denyMarker ? { denyMarker: extraction.denyMarker } : {}),
    ...(extraction.revokeMarker ? { revokeMarker: extraction.revokeMarker } : {}),
    ...(extraction.denyScope ? { denyScope: extraction.denyScope } : {}),
  }
}

export function describeTaskExecutionState(taskState: TaskExecutionState): string | null {
  // workspace scope is the default — emitting a banner each turn would just spam the transcript
  // without adding signal (the workspace boundary is implicit). Stay silent until an explicit
  // write scope has been derived from user input.
  if (taskState.contract.scopeMode === 'workspace') {
    return null
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
  // 0.13.67: lifetime monotonic counter — increments once per call,
  // unaffected by closure-iter resets across runtime auto-retries.
  // The 2026-05-07 deepseek dogfood proved that
  // `runConversationLoop`'s closure `iterations` resets to 1 after
  // every retry, so guards keyed on it would never see "task has
  // already burned 9 attempts." `lifetimeIterations` is monotonic
  // across the entire task lifetime within one ActiveTaskState.
  taskState.run.lifetimeIterations = (taskState.run.lifetimeIterations ?? 0) + 1
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
  attemptedPaths: string[] = [attemptedPath],
): void {
  const now = Date.now()
  const pendingPaths = attemptedPaths.length > 0 ? attemptedPaths : [attemptedPath]
  taskState.run.status = 'waiting_user'
  taskState.run.lastGuardReason = reason
  taskState.run.pendingWriteApproval = {
    attemptedPaths: dedupeStrings([
      ...(taskState.run.pendingWriteApproval?.attemptedPaths ?? []),
      ...pendingPaths,
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
  rawToolName: string,
  input: Record<string, unknown>,
  taskState?: TaskExecutionState,
): WriteGuardViolation | null {
  if (!taskState) return null
  // Wrong-case "Write"/"Bash" must still be path-extracted and scope-checked.
  const toolName = canonicalToolName(rawToolName)
  const attemptedPaths = extractWriteTargetPaths(toolName, input, taskState.contract.cwd)
  if (attemptedPaths.length === 0) return null

  // external_reference scopes are read-reference signals only — they must not
  // authorize any writes, including bash writes that bypass fs-policy (the P1 bug).
  const allowedScopes = taskState.contract.allowedWritePaths.filter(
    (scope) => scope.origin !== 'external_reference',
  )
  const shellScratchAllowed = SHELL_ARTIFACT_TOOLS.has(toolName)
  const blockedPaths: string[] = []
  for (const candidate of attemptedPaths) {
    const isExternalScratchArtifact =
      shellScratchAllowed
      && !isWithinRoot(candidate, taskState.contract.cwd)
      && isScratchArtifactPath(candidate)
    if (
      taskState.contract.scopeMode === 'explicit_paths'
      && !isExternalScratchArtifact
      && !allowedScopes.some((scope) => pathMatchesScope(candidate, scope))
    ) {
      blockedPaths.push(candidate)
    }
  }
  const attemptedPath = blockedPaths[0] ?? null
  if (!attemptedPath) return null

  const allowedPaths = allowedScopes.map((scope) => scope.path)

  // If fs-policy would also reject this path (sensitive location, outside
  // workspace, etc.), surface that as the dominant reason. Hostile-QA B3
  // showed `/etc/passwd` getting the bland "task contract blocked" copy
  // when fs-policy had a much more specific verdict ("Refusing to write
  // to sensitive location: /etc"). Same path twice through two guards
  // should pick the strongest, most specific message.
  const fsVerdict = checkWritePathAllowed(attemptedPath, { workspaceRoot: taskState.contract.cwd })
  if (!fsVerdict.allowed) {
    return {
      attemptedPath,
      attemptedPaths: blockedPaths,
      allowedPaths,
      message: fsVerdict.reason,
    }
  }

  const summary = allowedPaths.slice(0, 4).join(', ')
  const more = allowedPaths.length > 4 ? ` (+${allowedPaths.length - 4} more)` : ''
  return {
    attemptedPath,
    attemptedPaths: blockedPaths,
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
  if (!attemptedPath) return

  const inWorkspace = isWithinRoot(attemptedPath, taskState.contract.cwd)
  const inAllowedExternal = !inWorkspace
    && taskState.contract.allowedWritePaths.some(
      (scope) => scope.origin === 'user-external' && pathMatchesScope(attemptedPath, scope),
    )
  if (!inWorkspace && !inAllowedExternal) return

  recordTouchedPath(taskState, attemptedPath)
  markTaskProgress(taskState)
}

// Interpreter-inline execution markers: `python -c`, `node -e`, `perl/ruby -e`,
// and heredocs (whose bodies extractBashArtifactPaths strips). When a command
// runs code through one of these, any file it writes lives in interpreter
// source (e.g. python `os.replace('out.jsonl')`) — invisible to shell-syntax
// parsing. We ground those on the filesystem instead (see fileModifiedSince).
const INTERPRETER_INLINE_EXEC_RE =
  /\b(?:python[0-9.]*|node|deno|bun|perl|ruby|php|Rscript)\b[^\n;&|]*?\s-(?:c|e)\b|<<-?\s*['"]?[A-Za-z_]/

// Path-like tokens carrying a known data/source extension. Quotes/parens/commas
// (the delimiters interpreters use around string-literal paths) bound the match
// without being captured.
const CANDIDATE_WRITE_PATH_RE =
  /(?:^|[\s'"=(,])((?:\.{0,2}\/)?[A-Za-z0-9_./@%+-]+\.(?:jsonl|ndjson|json|csv|tsv|parquet|txt|md|markdown|ya?ml|toml|ini|cfg|conf|log|html?|xml|py|sh|bash|zsh|js|mjs|cjs|ts|tsx|jsx|sql|db|sqlite))(?=$|['"\s,):;])/g

function commandHasInterpreterInlineExec(command: string): boolean {
  return INTERPRETER_INLINE_EXEC_RE.test(command)
}

function extractInterpreterWriteCandidates(command: string, cwd: string): string[] {
  const out: string[] = []
  for (const match of command.matchAll(CANDIDATE_WRITE_PATH_RE)) {
    const raw = match[1]
    if (!raw) continue
    out.push(canonicalizePath(isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)))
  }
  return dedupeStrings(out)
}

/** True when `path` exists and was modified at/after `sinceMs` (with a small
 *  tolerance for coarse filesystem mtime granularity). This is the runtime-fact
 *  signal that an interpreter-mentioned path was actually written during the
 *  command's execution window — a read of a static file has an older mtime. */
function fileModifiedSince(path: string, sinceMs: number): boolean {
  try {
    if (!existsSync(path)) return false
    return statSync(path).mtimeMs >= sinceMs - 2000
  } catch {
    return false
  }
}

function bashFsProgressEnabled(): boolean {
  const raw = process.env['OWLCODA_BASH_FS_PROGRESS']
  if (raw === undefined) return true
  const lowered = raw.trim().toLowerCase()
  return !(lowered === '0' || lowered === 'false' || lowered === 'no' || lowered === 'off')
}

export async function recordBashArtifactProgress(
  taskState: TaskExecutionState | undefined,
  toolName: string,
  input: Record<string, unknown>,
  executionStartMs?: number,
): Promise<void> {
  if (!taskState || !SHELL_ARTIFACT_TOOLS.has(toolName)) return
  const command = input['command']
  if (typeof command !== 'string' || !command.trim()) return
  const cwd = resolveToolCwd(input, taskState.contract.cwd)
  const paths = extractBashArtifactPaths(command, cwd)

  // Interpreter-internal writes (python -c / node -e / heredoc-fed scripts):
  // the write target is a string literal inside interpreter source, invisible
  // to shell-syntax parsing. Ground on the filesystem — a mentioned path that
  // exists AND was modified within this command's execution window is a real
  // write; read-only mentions of static files are excluded by their older
  // mtime. Default on; escape hatch OWLCODA_BASH_FS_PROGRESS=0.
  if (
    executionStartMs !== undefined
    && bashFsProgressEnabled()
    && commandHasInterpreterInlineExec(command)
  ) {
    for (const candidate of extractInterpreterWriteCandidates(command, cwd)) {
      if (paths.includes(candidate)) continue
      if (fileModifiedSince(candidate, executionStartMs)) paths.push(candidate)
    }
  }

  if (paths.length === 0) return

  let recorded = false
  const ledgerWrites: Array<Promise<unknown>> = []
  for (const artifactPath of paths) {
    const inWorkspace = isWithinRoot(artifactPath, taskState.contract.cwd)
    const inAllowedExternal = !inWorkspace
      && taskState.contract.allowedWritePaths.some(
        (scope) => scope.origin === 'user-external' && pathMatchesScope(artifactPath, scope),
      )
    const durable = inWorkspace || inAllowedExternal
    if (durable) {
      recordTouchedPath(taskState, artifactPath)
      const runWorkspace = taskState.run.runWorkspace
      if (runWorkspace && isWithinRoot(artifactPath, runWorkspace.outputRoot)) {
        ledgerWrites.push(recordArtifact(runWorkspace.runDir, {
          path: artifactPath,
          origin: 'bash_detected',
          participatesInFinal: isWithinRoot(artifactPath, resolve(runWorkspace.outputRoot, 'final')),
        }).catch(() => undefined))
      }
      recorded = true
    } else if (isScratchArtifactPath(artifactPath)) {
      taskState.run.scratchArtifactPaths = dedupeStrings([
        ...(taskState.run.scratchArtifactPaths ?? []),
        artifactPath,
      ])
      recorded = true
    }
  }
  if (!recorded) return

  markArtifactProgress(taskState)
  if (ledgerWrites.length > 0) {
    await Promise.all(ledgerWrites)
  }
}

export function recordToolExecutionProgress(
  taskState: TaskExecutionState | undefined,
  toolName: string,
  input: Record<string, unknown>,
  metadata?: Record<string, unknown>,
): void {
  if (!taskState || !EXECUTION_PROGRESS_TOOLS.has(toolName)) return
  recordRunWorkspaceState(taskState, toolName, metadata)

  let recordedPath = false
  for (const candidate of extractToolProgressPaths(toolName, input, metadata, taskState.contract.cwd)) {
    if (recordDurableProgressPath(taskState, candidate)) {
      recordedPath = true
    }
  }

  // Structured execution tools are first-class progress signals even when
  // they only advance the plan/verification ledger. They should keep the
  // repair window open, but only explicit artifact paths above become durable
  // touched paths.
  if (recordedPath || isExecutionProgressToolCall(toolName, input)) {
    markArtifactProgress(taskState)
  }
}

export interface EnsureRunWorkspaceResult {
  created: boolean
  reason?: string
  outputRoot?: string
  runDir?: string
}

export async function ensureRunWorkspaceForStructuredTask(
  taskState: TaskExecutionState | undefined,
  toolName: string,
  input: Record<string, unknown>,
  metadata?: Record<string, unknown>,
): Promise<EnsureRunWorkspaceResult> {
  if (!taskState) return { created: false, reason: 'no_task_state' }
  if (toolName !== 'TaskCreate') return { created: false, reason: 'not_task_create' }
  if (taskState.run.runWorkspace) return { created: false, reason: 'already_exists' }

  const stepCount = extractTaskStepCount(input, metadata)
  if (stepCount <= 0) return { created: false, reason: 'no_structured_steps' }

  const deliverable = classifyDeliverableContract(`${taskState.contract.objective} ${taskState.contract.sourceText}`)
  if (deliverable.mode !== 'file_artifact_delivery') {
    return { created: false, reason: `unsupported_deliverable_mode:${deliverable.mode}` }
  }

  const scope = selectRunWorkspaceWriteScope(taskState)
  if (!scope) return { created: false, reason: 'no_trusted_write_scope' }

  const outputRoot = scope.kind === 'file' ? dirname(scope.path) : scope.path
  const manifestPath = resolve(outputRoot, '.owlcoda-run', 'manifest.json')
  const fsVerdict = checkWritePathAllowed(manifestPath, {
    workspaceRoot: taskState.contract.cwd,
    allowedRoots: [outputRoot],
  })
  if (!fsVerdict.allowed) {
    return { created: false, reason: `fs_policy:${fsVerdict.reason}`, outputRoot }
  }
  try {
    const result = await createRunWorkspace({
      outputRoot,
      cwd: taskState.contract.cwd,
      taskFamily: inferTaskFamilyForRunWorkspace(taskState),
      deliverableMode: deliverable.mode,
      plan: buildRunWorkspacePlanFromTaskCreate(input, metadata),
    })

    taskState.run.runWorkspace = {
      runId: result.manifest.runId,
      outputRoot: result.paths.outputRoot,
      runDir: result.paths.runDir,
      manifestPath: result.paths.manifestPath,
      checkpointPath: result.paths.checkpointPath,
      artifactsPath: result.paths.artifactsPath,
      eventsPath: result.paths.eventsPath,
      createdAt: result.manifest.createdAt,
      artifactCount: 0,
      ...(result.manifest.taskFamily ? { taskFamily: result.manifest.taskFamily } : {}),
      ...(result.manifest.deliverableMode ? { deliverableMode: result.manifest.deliverableMode } : {}),
    }

    // B5: Add outputRoot to allowedWritePaths so Bash/write tools that land
    // artifacts inside the run workspace are not rejected by the write guard.
    // origin='run_workspace' is NOT in the external_reference filter list in
    // evaluateWriteGuard — it is a legitimate, runtime-derived write scope.
    // We always push a 'run_workspace' scope even when the same path is
    // covered by 'user-external', so telemetry can count it distinctly and
    // so the scope is unambiguously visible as a RunWorkspace-derived grant.
    const canonicalOutputRoot = canonicalizePath(result.paths.outputRoot)
    const alreadyRunWorkspaceScoped = taskState.contract.allowedWritePaths.some(
      (scope) => scope.origin === 'run_workspace' && normalize(scope.path) === normalize(canonicalOutputRoot),
    )
    if (!alreadyRunWorkspaceScoped) {
      taskState.contract.allowedWritePaths.push({
        path: canonicalOutputRoot,
        kind: 'directory',
        origin: 'run_workspace',
      })
      // Note: dedupeScopes deduplicates by kind+path key (last-wins), so
      // run_workspace will survive alongside user-external for the same path
      // because they share the same canonical path but the Map key is unique
      // per kind+path regardless of origin. We use the raw array to preserve
      // all origin values, so skip dedupeScopes here to avoid losing them.
      taskState.contract.updatedAt = Date.now()
    }

    recordToolExecutionProgress(taskState, 'RunWorkspace', { action: 'create' }, { runDir: result.paths.runDir })
    return { created: true, outputRoot: result.paths.outputRoot, runDir: result.paths.runDir }
  } catch (err) {
    return {
      created: false,
      reason: `create_failed:${err instanceof Error ? err.message : String(err)}`,
      outputRoot,
    }
  }
}

/**
 * Returns all scopes from `allowedWritePaths` that were declared by the user
 * as external deliverable targets (origin === 'user-external'), preserving the
 * `kind` field so fs-policy can apply the correct matching semantics:
 *   - kind === 'file': exact-match only (no descendants)
 *   - kind === 'directory': exact or descendant paths allowed
 *
 * Consumed by fs-policy callers via `externalScopes` in FsPolicyOptions.
 */
export function extractUserDeclaredExternalRoots(
  taskState: TaskExecutionState | undefined,
): Array<{ path: string; kind: 'file' | 'directory' }> {
  if (!taskState) return []
  return taskState.contract.allowedWritePaths
    .filter((scope) => scope.origin === 'user-external')
    .map((scope) => ({ path: scope.path, kind: scope.kind }))
}

function extractTaskStepCount(input: Record<string, unknown>, metadata?: Record<string, unknown>): number {
  const metadataTask = metadata?.['task']
  if (isRecordLike(metadataTask) && typeof metadataTask['stepCount'] === 'number') {
    return metadataTask['stepCount']
  }
  const steps = input['steps']
  return Array.isArray(steps) ? steps.length : 0
}

function selectRunWorkspaceWriteScope(taskState: TaskExecutionState): TaskPathScope | null {
  const userExternal = taskState.contract.allowedWritePaths.find(
    scope => scope.origin === 'user-external' && scope.kind === 'directory',
  )
  if (userExternal) return userExternal
  return null
}

function inferTaskFamilyForRunWorkspace(taskState: TaskExecutionState): TaskFamily {
  const text = normalizeWhitespace(`${taskState.contract.objective} ${taskState.contract.sourceText}`).toLowerCase()
  if (/(ppt|deck|slide|slides|presentation|幻灯片|演示文稿|简报)/i.test(text)) return 'deck'
  if (/(image|images|picture|diagram|asset|图片|图像|视觉|配图)/i.test(text)) return 'image_asset'
  if (/(research|survey|benchmark|investigate|调研|研究|分析|对比)/i.test(text)) return 'research'
  if (/(csv|xlsx|spreadsheet|table|dataset|report|报表|数据表|数据集)/i.test(text)) return 'data_report'
  if (/(release|publish|npm|tag|changelog|发布|发版)/i.test(text)) return 'release'
  if (/(code|implement|refactor|test|fix|源码|代码|实现|修复|重构)/i.test(text)) return 'code'
  return 'general'
}

function buildRunWorkspacePlanFromTaskCreate(
  input: Record<string, unknown>,
  metadata?: Record<string, unknown>,
): Record<string, unknown> {
  const metadataTask = metadata?.['task']
  const taskId = isRecordLike(metadataTask) && typeof metadataTask['id'] === 'string'
    ? metadataTask['id']
    : undefined
  return {
    source: 'TaskCreate',
    ...(taskId ? { taskId } : {}),
    ...(typeof input['subject'] === 'string' ? { subject: input['subject'] } : {}),
    ...(typeof input['description'] === 'string' ? { description: input['description'] } : {}),
    steps: Array.isArray(input['steps']) ? input['steps'] : [],
  }
}

export function hasRecentArtifactProgress(
  taskState: TaskExecutionState,
  repairWindowIterations: number,
): boolean {
  const lastAttempt = taskState.run.lastArtifactProgressIteration
  if (typeof lastAttempt !== 'number' || lastAttempt <= 0) return false
  const current = taskState.run.lifetimeIterations ?? 0
  return current - lastAttempt <= repairWindowIterations
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
  // 0.13.58: tightened phrasing. Pre-0.13.58 said "Continue the task
  // now. Do not stop at another interim summary." Models routinely
  // interpreted that as "produce another planning paragraph" —
  // exactly the failure mode the inject was meant to prevent. New
  // version explicitly demands EITHER a tool call OR a concrete
  // file_path:line cite, and bans high-level summaries / plan
  // restatements.
  return [
    '[Runtime continue-while-open]',
    `Objective: ${taskState.contract.objective}`,
    `Dominant gap: ${dominantGap}`,
    `Your last message looked like an interim progress update, not a finished task: ${trimmedAssistantText}`,
    'Your next response MUST be one of:',
    '  (a) a tool call that materially advances the task, OR',
    '  (b) a one-line claim citing file_path:line_number evidence (e.g.',
    '      "Found bug at src/foo.ts:42") followed by the next tool call.',
    'Do NOT produce another high-level summary. Do NOT restate the plan.',
    'Only stop if the task is actually completed, you need user input ' +
      '(state the specific question), or you hit a concrete blocker (state which one).',
  ].join('\n')
}

/**
 * Build the runtime-injected nudge that fires when the model's
 * previous response hit `stop_reason: 'max_tokens'` (0.13.64). The
 * model wanted to write more but its per-response output cap cut
 * the reply mid-content; without a follow-up nudge the conversation
 * loop just continues and the model often re-renders the whole
 * thing again from scratch (and may hit the same cap). New behavior:
 * inject a specific "continue from where you left off" message that
 * names the truncation and tells the model exactly what to do.
 *
 * Includes a tail snippet of the truncated text so the model can
 * resume rather than restart. Cap at ~400 chars to keep the inject
 * itself small.
 */
export function buildMaxTokensContinuationPrompt(
  truncatedText: string,
  consecutiveTruncations: number,
): string {
  const tail = truncatedText.length > 400
    ? '…' + truncatedText.slice(-400)
    : truncatedText
  const lines: string[] = ['[Runtime max-tokens continuation]']
  if (consecutiveTruncations >= 2) {
    lines.push(
      `Your last ${consecutiveTruncations} replies hit stop_reason=max_tokens — ` +
      `the per-response output cap cut you off mid-content each time. ` +
      `Continuing the same approach will hit the cap again.`,
    )
    lines.push('')
    lines.push(
      'Stop trying to render the full deliverable inline. Instead, your next reply MUST be one of:',
    )
    lines.push('  (a) a tool call (write / edit) that lands the deliverable as a file, OR')
    lines.push('  (b) a one-paragraph summary stating what content is left and asking the user how to scope it down.')
  } else {
    lines.push(
      'Your previous reply hit stop_reason=max_tokens — the per-response output cap ' +
      'cut you off mid-content. The conversation has the partial response.',
    )
    lines.push('')
    lines.push(
      'Continue from where you left off. Do NOT restart the section / table / report — ' +
      'pick up at the next sentence. If the remaining content would exceed the output ' +
      'cap again, switch strategy: write to a file (write tool) or break the deliverable ' +
      'into a sequence of smaller tool calls.',
    )
  }
  lines.push('')
  lines.push('Tail of the truncated reply (for resume context):')
  lines.push(tail)
  return lines.join('\n')
}

/**
 * Build the runtime-injected nudge that fires when the assistant has
 * produced large inline output for several iterations in a row
 * without making progress (0.13.63 D). The pattern: model gets
 * stuck, dumps a 30K-char "fallback summary table" each turn rather
 * than tool-calling forward — the cumulative text bloats both
 * context and host heap (the latter caused the 0.13.62 OOM).
 *
 * Once-per-session by design: the goal is to interrupt a runaway
 * inline-dump pattern, not to nag for every long answer.
 */
export function buildOutputBloatPrompt(
  consecutiveLargeOutputCount: number,
  approxCharsPerOutput: number,
): string {
  return [
    '[Runtime output-bloat check]',
    `Your last ${consecutiveLargeOutputCount} replies have each been around ` +
    `${(approxCharsPerOutput / 1000).toFixed(0)}K characters of inline content. ` +
    `That pattern usually means you are stuck on a deliverable that should be a ` +
    `file write or a follow-up tool call but is being re-dumped as plain text instead.`,
    '',
    'Stop dumping the same content again. Your next reply MUST be one of:',
    '  (a) a single tool call (write / edit / bash) that materially advances the task, OR',
    '  (b) one short paragraph stating exactly which decision is blocking you, ' +
    '      then a specific question for the user.',
    '',
    'Do NOT re-render the table / report / contract you already produced. ' +
    'The conversation has it. Move forward.',
  ].join('\n')
}

/**
 * Build the runtime-injected nudge that fires when the conversation's
 * post-compact context usage crosses a pressure threshold (0.13.58).
 * Two thresholds in practice (0.6 = soft, 0.85 = strict). Each fires
 * once per session per threshold; the conversation loop tracks fired
 * thresholds on `conversation.options.contextPressureNudgesFired`.
 *
 * The mionyee-hermes long-context dogfood (deepseek-v4-pro at 800K+
 * tokens) showed two specific degradation modes that this nudge
 * targets:
 *   1. Model re-asks facts already in scrollback (long-context
 *      recall failure). The nudge tells it to grep before asking.
 *   2. Model writes paragraphs of plan-restating prose. The nudge
 *      tells it to lead with the key fact in one line, then take
 *      action.
 *
 * Tone: the nudge is a *system observation* fed back as context, not
 * a punitive rule. The model reads it and adapts; if it doesn't, the
 * other guards (continue-while-open, summary gate, soft loop
 * intercept) still apply.
 */
export function buildContextPressurePrompt(
  threshold: number,
  usageRatio: number,
  totalTokens: number,
  contextWindow: number,
): string {
  const usagePct = (usageRatio * 100).toFixed(0)
  const thresholdPct = (threshold * 100).toFixed(0)
  const lines: string[] = ['[Runtime context-pressure check]']
  lines.push(
    `Context usage just crossed ${thresholdPct}% ` +
    `(now ${usagePct}%, ${totalTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens). ` +
    `The conversation has grown long; recall and decisiveness on long context degrade for every model.`,
  )
  lines.push('')
  if (threshold >= 0.85) {
    lines.push('Strict mode (>=85%):')
    lines.push('  - Replies: one fact + the next concrete action. No narration, no plan restatements.')
    lines.push('  - Tools: only the calls strictly needed to advance the dominant gap.')
    lines.push('  - If the task is open-ended, summarize state in one paragraph and ask the user to ' +
      'narrow scope or cut the conversation. Do not start new exploration tracks.')
  } else {
    lines.push('Soft mode (>=60%):')
    lines.push('  - Lead each reply with the key fact in one line (file_path:line where possible).')
    lines.push('  - Batch independent tool calls in a single message.')
    lines.push('  - Before asking the user a clarifying question, grep / read for the answer first — ' +
      'long-context recall fails silently and you may be re-asking something already in scope.')
    lines.push('  - When you summarize, restate only the load-bearing facts (decisions, file paths, ' +
      'constraints). Skip restating what the user said.')
  }
  return lines.join('\n')
}

/**
 * 0.13.70 execution_economics_v1 — production_gate_v1.
 *
 * Inject when the task contract requires a write deliverable, the
 * model has done genuine investigation (>=3 distinct files read,
 * >=5 lifetime iterations elapsed), but no deliverable has landed
 * (touchedPaths still empty). This is the soft, one-shot push
 * Codex/Sonnet 4 give themselves implicitly: "you have enough
 * source evidence; switch to producing now."
 *
 * Distinct from:
 *   - 0.13.66 narration-loop detector: catches PURE-text loops, hard-stop.
 *   - 0.13.68 task-no-progress ceiling: catches lifetime > 8, hard-stop.
 *
 * production_gate_v1 fires earlier (lifetime >= 5), is one-shot,
 * does NOT terminate. It's an advisory inject in the
 * "tool-surface side-channel signaling" tradition (SWE-agent ACI).
 */
export function buildProductionGatePrompt(
  details: {
    distinctFilesRead: number
    lifetimeIterations: number
    taskWriteScope: string | null
  },
): string {
  const lines: string[] = ['[Runtime production gate]']
  lines.push(
    `You have read ${details.distinctFilesRead} distinct file${details.distinctFilesRead === 1 ? '' : 's'} ` +
    `across ${details.lifetimeIterations} iterations under a task contract that requires a write ` +
    `deliverable. No deliverable has landed yet (0 touched paths).`,
  )
  lines.push('')
  lines.push('You have enough source evidence to begin drafting. Switch from investigation to production:')
  if (details.taskWriteScope) {
    lines.push(`  - Write the artifact to the task-scoped path: ${details.taskWriteScope}`)
  } else {
    lines.push('  - Write the artifact to the path scoped by the task contract.')
  }
  lines.push('  - Mark unknowns explicitly under a "Known Unverified Items" (or equivalent) section.')
  lines.push('  - Each non-trivial claim should cite a source path or be tagged unverified.')
  lines.push('  - Do not gather more broad context. If you genuinely need a specific symbol, ' +
    'prefer grep or a line-range read over re-reading whole files.')
  lines.push('')
  lines.push('This nudge fires once per task. Producing the artifact (even with unknowns flagged) ' +
    'satisfies it; continuing to read does not.')
  return lines.join('\n')
}

/**
 * Detect "I'm done"-style claims in assistant text. Used by the
 * conversation loop to decide whether to inject a delivery-check
 * nudge before letting the assistant exit. Cheap regex match — false
 * positives are acceptable because the worst case is "model gets
 * asked to verify; verification turns up clean; model proceeds."
 *
 * Triggers on completion verbs in either English or Chinese:
 *   "已完成", "完成了", "跑通了", "测试通过", "部署成功"
 *   "done", "complete", "passed", "shipped", "deployed", "merged",
 *   "all green", "all tests pass"
 *
 * Conservative — requires the verb to be near the start or end of a
 * sentence/line so we don't trip on "the test will pass after we add
 * the assertion" mid-paragraph.
 */
const COMPLETION_CLAIM_PATTERNS: RegExp[] = [
  /(?:已完成|完成了|跑通了|测试通过|部署成功|发布成功|全部通过|全绿|搞定了|落地了)/,
  /\b(?:all done|all complete|completed|task complete|delivery complete|shipped|deployed|merged)\b/i,
  /\b(?:tests? pass(?:ed|ing)?|all (?:tests?|specs?) (?:pass|green))\b/i,
  /\ball green\b/i,
  /\b(?:built|build) (?:successfully|clean|green)\b/i,
]

export function detectCompletionClaim(text: string): boolean {
  if (!text || text.length === 0) return false
  for (const pattern of COMPLETION_CLAIM_PATTERNS) {
    if (pattern.test(text)) return true
  }
  return false
}

/**
 * True when `text` already cites concrete file evidence for at least
 * one of the paths in `touchedPaths`. The delivery-check hook treats
 * this as "claim is self-evidencing" and skips the nudge — there's
 * no point nagging the model to audit a claim it already backed up
 * with file paths.
 *
 * Match is on basename only (so `docs/final-report.md` in touchedPaths
 * matches "wrote final-report.md to docs/" in the text). Cheap regex,
 * no path resolution.
 */
export function completionCitesTouchedPaths(text: string, touchedPaths: string[]): boolean {
  if (touchedPaths.length === 0) return false
  for (const path of touchedPaths) {
    const basename = path.split(/[\\/]/).pop() ?? path
    if (basename.length < 4) continue // skip noise like "x.ts"
    if (text.includes(basename)) return true
  }
  return false
}

/**
 * Build the runtime-injected nudge that fires when a completion claim
 * is detected but DeliveryAudit hasn't run yet (or hasn't run since
 * the most recent file mutation). Phrased as a single user-role
 * message so it slots cleanly into the existing inject pattern used
 * by buildTaskContinuePrompt / buildTaskRealignPrompt.
 */
export function buildDeliveryCheckPrompt(
  taskState: TaskExecutionState,
  latestAssistantText: string,
): string {
  const trimmed = truncateForState(normalizeWhitespace(latestAssistantText), 200)
  const touched = taskState.contract.touchedPaths.length
  return [
    '[Runtime delivery check]',
    `Your last message claimed completion ("${trimmed}"), and the working tree has ${touched} touched path(s) recorded this turn.`,
    'Before stating "done", run DeliveryAudit with the specific claims you just made. Example:',
    '  DeliveryAudit({ claims: ["added <file>", "shipped <version>", "tests pass"] })',
    'Reconcile any unsupported claim against the audit verdict before re-asserting completion.',
    'If the audit comes back clean, restate completion with the audit summary attached so the operator has evidence, not just assertion.',
  ].join('\n')
}

/**
 * User intent classification, derived from the latest substantive user
 * message. Used by the autonomy-boundary guards added in 0.13.48 to
 * stop the agent from auto-jumping from "what do you think?" to
 * "I edited 5 files for you."
 *
 *   - 'analysis'      — user asked for judgment / opinion / explanation only
 *   - 'implementation'— user gave an explicit verb to do something
 *   - 'mixed'         — both signals present (treat as implementation; user named the action)
 *   - 'neutral'       — neither (or message is empty); status quo behaviour
 */
export type UserIntent = 'analysis' | 'implementation' | 'mixed' | 'neutral'

const ANALYSIS_INTENT_PATTERNS: RegExp[] = [
  // Chinese — judgment / opinion forms
  /(?:你觉得|你的判断|你怎么看|怎么样|怎么看待|怎么回事|是怎么)/,
  /(?:为什么|为啥|原因|理由)/,
  /(?:评估|评价|评分|分析(?:一下|看)?|看一下|看看|核对|核一下|查一下)/,
  /(?:质量(?:如何|怎样)|表现(?:如何|怎样)|做得怎么样)/,
  /(?:解释一下|说说|讲讲|告诉我)/,
  // English — judgment / opinion forms
  /\bwhy\s+(?:is|does|did|do|are|was|were|would|should)\b/i,
  /\bhow come\b/i,
  /\bwhat do you think\b/i,
  /\bhow about\b/i,
  /\b(?:your|my)\s+(?:opinion|verdict|take|view|assessment|judg(?:e?ment))\b/i,
  /\bhow is the\b/i,
  /\bwhat'?s the (?:reason|cause|verdict|state|status|quality)\b/i,
]

const IMPLEMENTATION_INTENT_PATTERNS: RegExp[] = [
  // Chinese — action verbs
  /(?:实施|落地|动手|改一下|修一下|写一个|加一个|删除|删掉|重构|加上|补上|修复|继续修|继续做|继续实现|继续落地|帮我改|帮我修|帮我加|帮我做|提一次|发布一下|落进去|动一下)/,
  /(?:接着改|接着写|接着做|接着修)/,
  // English — action verbs
  /\b(?:fix|implement|refactor|add|remove|write|create|edit|modify|patch|build|deploy|merge|ship)\s+(?:it|that|this|the|a|an|some)\b/i,
  /\b(?:proceed|go ahead|do it|make it so|carry on|land it|push it|commit it)\b/i,
  /\b(?:please|pls)\s+(?:fix|implement|refactor|add|remove|write|create|edit|modify|patch|build|deploy|merge|ship|do)\b/i,
]

/**
 * Classify the intent of a single user-message string. The latest
 * substantive user message is what counts — `infer*` callers should
 * pre-filter `继续` / `continue` shorthand themselves.
 */
export function inferUserIntent(text: string): UserIntent {
  if (!text || text.trim().length === 0) return 'neutral'
  const hasAnalysis = ANALYSIS_INTENT_PATTERNS.some((re) => re.test(text))
  const hasImplementation = IMPLEMENTATION_INTENT_PATTERNS.some((re) => re.test(text))
  if (hasAnalysis && hasImplementation) return 'mixed'
  if (hasAnalysis) return 'analysis'
  if (hasImplementation) return 'implementation'
  return 'neutral'
}

const ANALYSIS_GUARD_TOOLS = new Set(['write', 'edit', 'NotebookEdit'])

export interface IntentGuardViolation {
  toolName: string
  intent: UserIntent
  reason: string
  /** Why it gated: 'analysis' = inferred analysis-only intent (softened to a
   *  hint under OWLCODA_MODES); 'probeplan' = ProbePlan allowlist (stays hard). */
  reasonKind: 'analysis' | 'probeplan'
}

/**
 * Decide whether a tool call should be refused because the user's
 * most recent substantive message asked for analysis only — a
 * judgment / opinion / explanation, not an implementation. The agent
 * routinely auto-jumps from "what do you think?" to "I edited 5 files
 * for you" (the Sierac-class failure mode).
 *
 * 0.13.48 covered `write` / `edit` / `NotebookEdit`. 0.13.52 added
 * bash + TaskCreate mutation detection and probe-consent override.
 * 0.13.53 closes one more leak surface a hostile-QA pass surfaced:
 *
 *   ProbePlan-allowlist mode — `inferUserIntent` only fires `analysis`
 *   when the user message contains specific judgment keywords (评估 /
 *   why / what do you think). A long hostile-QA prompt that *describes*
 *   QA work but doesn't use those exact verbs returns `neutral`, which
 *   used to bypass the guard entirely. When the conversation has any
 *   active `ProbePlan` registration, the user has explicitly listed the
 *   mutating shapes they authorize; calls outside that list need an
 *   explicit implementation verb. So under `hasActiveProbePlan`, any
 *   intent except `implementation` is treated like `analysis` — the
 *   probe-consent override still passes registered probes through, and
 *   read-only tools are still allowed.
 *
 * 'mixed' (analysis + implementation in same message) is treated as
 * implementation in normal mode: the user named the action explicitly.
 * In ProbePlan-allowlist mode it is treated as analysis: the registered
 * plan is the contract, ambiguous text doesn't override.
 */
const BASH_LIKE_TOOLS = new Set(['bash', 'TaskCreate'])

export function evaluateIntentGuard(
  rawToolName: string,
  intent: UserIntent,
  toolInput?: Record<string, unknown>,
  probeMatcher?: (toolName: string, input: Record<string, unknown>) =>
    | { groupId: string; probeId: string }
    | null,
  hasActiveProbePlan?: boolean,
): IntentGuardViolation | null {
  // Wrong-case "Write"/"Bash" must still hit the analysis-intent guard.
  const toolName = canonicalToolName(rawToolName)
  // Probe-consent override (checked first so registered probes pass
  // even in ProbePlan-allowlist mode): if the call matches an
  // unsatisfied registered probe, the user already consented to this
  // specific shape via ProbePlan registration. Allow.
  if (probeMatcher && toolInput) {
    const match = probeMatcher(toolName, toolInput)
    if (match) return null
  }

  // Decide whether this call should be gated. Existing rule: gate
  // when intent is 'analysis'. New 0.13.53 rule: when ProbePlan is
  // active, also gate when intent is anything other than explicit
  // 'implementation' — registration is the allowlist contract.
  const allowlistMode = hasActiveProbePlan === true
  const shouldGate =
    intent === 'analysis' || (allowlistMode && intent !== 'implementation')
  if (!shouldGate) return null

  const contextSuffix = allowlistMode
    ? `the conversation has an active ProbePlan registration; mutating ` +
      `tool calls outside the registered probes are blocked until the ` +
      `user replies with an explicit implementation verb. To allow this ` +
      `specific shape, register a ProbePlan probe whose mustContain ` +
      `matches it.`
    : `the user's most recent message reads as analysis-only (asking ` +
      `for judgment / opinion / explanation), not implementation. If ` +
      `they want files actually changed, they need to follow up with ` +
      `an explicit implementation verb — Chinese: 改一下 / 修一下 / 实施 / ` +
      `落地 / 动手 / 帮我做; English: fix it / implement / do it / ` +
      `proceed / go ahead. Don't auto-jump from "what do you think?" ` +
      `to "I edited 5 files."`

  if (ANALYSIS_GUARD_TOOLS.has(toolName)) {
    return {
      toolName,
      intent,
      reason: `Refusing ${toolName}: ${contextSuffix}`,
      reasonKind: allowlistMode ? 'probeplan' : 'analysis',
    }
  }

  if (BASH_LIKE_TOOLS.has(toolName) && toolInput) {
    const cmd = toolInput['command']
    if (typeof cmd === 'string' && cmd.length > 0) {
      const verdict = classifyBashCommand(cmd)
      if (verdict.mutatesFilesystem) {
        return {
          toolName,
          intent,
          reason:
            `Refusing ${toolName}: the command "${cmd.slice(0, 80)}${cmd.length > 80 ? '…' : ''}" ` +
            `mutates the filesystem (${verdict.reasons.join('; ') || verdict.level}); ` +
            contextSuffix,
          reasonKind: allowlistMode ? 'probeplan' : 'analysis',
        }
      }
    }
  }

  return null
}

/**
 * Latest substantive user message (skips bare "继续" / "continue"
 * shorthand). Exported so the conversation loop and the intent guard
 * can share a single source of truth on what counts as the user's
 * most recent ask.
 */
export function latestSubstantiveUserText(conversation: Conversation): string | null {
  for (let i = conversation.turns.length - 1; i >= 0; i--) {
    const turn = conversation.turns[i]
    if (!turn || turn.role !== 'user') continue
    const text = turn.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (!text) continue
    const normalized = normalizeWhitespace(text)
    if (CONTINUATION_ONLY_RE.test(normalized)) continue
    // Also skip runtime-injected user messages so a [Runtime
    // continue-while-open] inject doesn't hide the operator's real
    // analysis ask one turn earlier.
    if (text.startsWith('[Runtime ')) continue
    return text
  }
  return null
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
    if (collected.length > 0 && isTaskContractControlInput(normalizedText)) continue
    collected.push({ rawText: text, normalizedText })
  }
  return collected
}

function latestUserInputForTaskControl(conversation: Conversation): SubstantiveUserInput | null {
  for (let i = conversation.turns.length - 1; i >= 0; i--) {
    const turn = conversation.turns[i]
    if (!turn || turn.role !== 'user') continue
    const text = turn.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (!text) continue
    if (text.startsWith('[Runtime ')) continue
    return { rawText: text, normalizedText: normalizeWhitespace(text) }
  }
  return null
}

function isTaskContractControlInput(normalizedText: string): boolean {
  return CONTINUATION_ONLY_RE.test(normalizedText)
    || (isWriteScopeApprovalInput(normalizedText) && !lineHasConcretePath(normalizedText))
    || TASK_STATUS_CHECK_RE.test(normalizedText)
}

interface ExplicitWriteTargetResult {
  allTargets: string[]
  userExternalTargets: Set<string>
}

function collectExplicitWriteTargets(source: SubstantiveUserInput[], cwd: string): ExplicitWriteTargetResult {
  const candidates = new Set<string>()
  const userExternalPaths = new Set<string>()
  for (const entry of source) {
    let inForbiddenWriteSection = false
    let inAllowWriteSection = false
    for (const line of entry.rawText.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (isInlineForbiddenWriteSectionHeading(trimmed)) {
        inForbiddenWriteSection = true
        inAllowWriteSection = false
        continue
      }
      if (isAllowSectionHeading(trimmed)) {
        inForbiddenWriteSection = false
        inAllowWriteSection = true
        continue
      }
      if (isOtherSectionHeading(trimmed) || isBracketSectionHeading(trimmed)) {
        inForbiddenWriteSection = false
        inAllowWriteSection = false
      }
      const isAllowLine = isAllowedInlineWriteTargetLine(line)
      const isSuggestedFilenameLine = SUGGESTED_FILENAME_RE.test(line)
      for (const candidate of extractPathCandidates(line)) {
        // FORBIDDEN deny always takes precedence
        if (isForbiddenInlineWriteTargetLine(line, candidate)) continue
        if (inForbiddenWriteSection && !isAllowLine) continue
        if (isSuggestedFilenameLine && !isAllowLine && !inAllowWriteSection) continue
        if (isUnscopedBareFilenameReferenceLine(line, candidate) && !isAllowLine && !inAllowWriteSection) continue

        // If the candidate is absolute and not within cwd:
        //   - ALLOW-type line → accept as user-external deliverable target
        //   - Any line → accept as explicit external path (bug 2 fix: an absolute path
        //     explicitly named in backticks survives extractPathCandidates de-dup;
        //     do not silently drop it just because ALLOW phrasing is absent)
        {
          const cleaned = candidate.replace(/^['"`]+/, '').replace(/['"`),.;:]+$/, '').trim()
          if (cleaned && isAbsolute(cleaned) && !isWithinRoot(resolve(cleaned), cwd)) {
            const canonicalized = canonicalizePath(resolve(cleaned))
            candidates.add(canonicalized)
            if (isAllowLine) {
              userExternalPaths.add(canonicalized)
            }
            continue
          }
        }

        const resolved = resolveCandidatePath(candidate, cwd)
        if (resolved) candidates.add(resolved)
      }
    }
  }
  const inWorkspaceCandidates = [...candidates].filter(p => !userExternalPaths.has(p))
  for (const candidate of extractBootstrapWriteTargets(inWorkspaceCandidates, cwd)) {
    candidates.add(candidate)
  }
  return { allTargets: [...candidates], userExternalTargets: userExternalPaths }
}

function cleanCandidatePath(candidate: string): string {
  return candidate
    .replace(/^['"`]+/, '')
    .replace(/['"`),.;:]+$/, '')
    .trim()
}

function isUnscopedBareFilenameReferenceLine(line: string, candidate: string): boolean {
  const cleaned = cleanCandidatePath(candidate)
  if (!cleaned || cleaned.includes('/') || isAbsolute(cleaned) || PROJECT_PATH_PREFIX_RE.test(cleaned)) {
    return false
  }

  const stripped = cleanCandidatePath(
    line
      .trim()
      .replace(/^[#>*\-\s▎]+/, '')
      .replace(/^\d+[.)]\s*/, '')
      .replace(/^[-*]\s*/, '')
      .trim(),
  )
  return stripped === cleaned
}

function isForbiddenInlineWriteTargetLine(line: string, candidate: string): boolean {
  if (!lineHasConcretePath(line)) return false
  return FORBIDDEN_INLINE_WRITE_TARGET_RE.test(clauseAroundCandidate(line, candidate))
}

function isInlineForbiddenWriteSectionHeading(line: string): boolean {
  return !lineHasConcretePath(line) && FORBIDDEN_INLINE_WRITE_SECTION_RE.test(line)
}

function isAllowedInlineWriteTargetLine(line: string): boolean {
  return lineHasConcretePath(line) && ALLOW_INLINE_WRITE_TARGET_RE.test(line)
}

function isBracketSectionHeading(line: string): boolean {
  return !lineHasConcretePath(line) && /^【[^】]+】[:：]?$/.test(line)
}

function clauseAroundCandidate(line: string, candidate: string): string {
  const index = line.indexOf(candidate)
  if (index < 0) return line
  const before = line.slice(0, index)
  const after = line.slice(index + candidate.length)
  const start = Math.max(
    before.lastIndexOf('。'),
    before.lastIndexOf('！'),
    before.lastIndexOf('？'),
    before.lastIndexOf('.'),
    before.lastIndexOf('!'),
    before.lastIndexOf('?'),
    before.lastIndexOf(';'),
    before.lastIndexOf('；'),
  ) + 1
  const afterStops = ['。', '！', '？', '.', '!', '?', ';', '；']
    .map((ch) => after.indexOf(ch))
    .filter((pos) => pos >= 0)
  const end = afterStops.length > 0
    ? index + candidate.length + Math.min(...afterStops)
    : line.length
  return line.slice(start, end)
}

function isWriteScopeApprovalInput(text: string): boolean {
  const approvalText = stripPathLikeTokensForApproval(text)
  return WRITE_SCOPE_APPROVAL_RE.test(approvalText) && !WRITE_SCOPE_DENIAL_RE.test(approvalText)
}

function stripPathLikeTokensForApproval(text: string): string {
  return text
    .replace(BACKTICK_PATH_RE, ' ')
    .replace(GENERIC_PATH_RE, ' ')
    .replace(SINGLE_FILE_RE, ' ')
}

/**
 * Compute scope confidence from the derived allowedWritePaths.
 *
 * high:   ≥1 user-external scope (ALLOW phrasing + absolute external path),
 *         OR ≥1 explicit scope whose path is within the cwd (user directly named
 *         an in-workspace file / directory — normal task prompt pattern).
 * medium: explicit_paths mode, allowedWritePaths non-empty, but all explicit
 *         scopes are external-without-ALLOW (bug-2 case: parser extracted absolute
 *         paths from prose/backticks with no output declaration verb). The handoff /
 *         description-only prompt pattern lands here — external paths present but no
 *         user ALLOW signal, so we cannot trust the scope is correct.
 * low:    explicit_paths mode but allowedWritePaths empty (all candidates were
 *         denied), or workspace mode.
 *
 * Used by the fail-open task_no_progress gate: hard-stop only fires when high.
 */
function deriveScopeConfidence(
  scopeMode: 'workspace' | 'explicit_paths',
  allowedWritePaths: TaskPathScope[],
  cwd: string,
): TaskContractScopeConfidence {
  if (scopeMode !== 'explicit_paths') return 'low'
  if (allowedWritePaths.length === 0) return 'low'

  const hasUserExternal = allowedWritePaths.some(s => s.origin === 'user-external')
  if (hasUserExternal) return 'high'

  // An in-cwd explicit scope means the user named a workspace path directly —
  // a clear, high-confidence target (normal task prompt pattern).
  const hasInWorkspaceExplicit = allowedWritePaths.some(
    s => s.origin === 'explicit' && isWithinRoot(s.path, cwd),
  )
  if (hasInWorkspaceExplicit) return 'high'

  // Only external explicit scopes (without ALLOW phrasing) remain.
  // These come from absolute paths mentioned in backticks without output
  // declaration verbs — the handoff / description-only prompt pattern.
  // Parser may have misclassified these as write targets. Medium confidence.
  return 'medium'
}

function deriveAllowedWritePaths(
  explicitWriteTargets: string[],
  cwd: string,
  touchedPaths: string[],
  userExternalTargets: Set<string> = new Set(),
): TaskPathScope[] {
  const scopes: TaskPathScope[] = []
  for (const target of explicitWriteTargets) {
    const explicitKind = inferScopeKind(target)
    const isUserExternal = userExternalTargets.has(target)
    const inWorkspace = isWithinRoot(target, cwd)

    let origin: TaskPathScopeOrigin
    if (isUserExternal) {
      origin = 'user-external'
    } else if (inWorkspace) {
      origin = 'explicit'
    } else {
      // Absolute path mentioned in backticks/prose without an ALLOW phrase —
      // treat as a read reference only; must not authorize any writes.
      origin = 'external_reference'
    }
    scopes.push({ path: target, kind: explicitKind, origin })

    // For in-workspace file targets only, derive parent + companion test scopes.
    // External reference paths (origin='external_reference') must NOT get
    // parent_directory or companion scopes — that is the root cause of the P1 bug.
    if (origin === 'explicit' && explicitKind === 'file') {
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
    if (candidate && isLikelyPathCandidate(candidate)) matches.add(candidate)
  }
  for (const match of text.matchAll(SINGLE_FILE_RE)) {
    const candidate = match[1]?.trim()
    if (candidate) matches.add(candidate)
  }
  // Bug 2 fix: if the same line contains both an absolute path candidate
  // and a short-name (basename-only) candidate with the same basename,
  // drop the short name in favour of the absolute path. This prevents
  // `/absolute/external/deck-stage.js` from being ignored while
  // `deck-stage.js` gets resolved to cwd/deck-stage.js and wins.
  const allCandidates = [...matches]
  const absoluteCandidates = allCandidates.filter(c => isAbsolute(c.replace(/^['"`]+/, '').replace(/['"`),.;:]+$/, '').trim()))
  if (absoluteCandidates.length > 0) {
    const absoluteBasenames = new Set(
      absoluteCandidates.map(c => basename(c.replace(/^['"`]+/, '').replace(/['"`),.;:]+$/, '').trim())),
    )
    return allCandidates.filter(c => {
      const cleaned = c.replace(/^['"`]+/, '').replace(/['"`),.;:]+$/, '').trim()
      // Keep absolute paths always
      if (isAbsolute(cleaned)) return true
      // Drop short-name candidates whose basename is already covered by an absolute candidate
      if (!cleaned.includes('/') && absoluteBasenames.has(cleaned)) return false
      return true
    })
  }
  return allCandidates
}

function isLikelyPathCandidate(candidate: string): boolean {
  return candidate.startsWith('/')
    || candidate.startsWith('./')
    || candidate.startsWith('../')
    || candidate.startsWith('~/')
    || candidate.endsWith('/')
    || PROJECT_PATH_PREFIX_RE.test(candidate)
    || extname(candidate) !== ''
}

function resolveCandidatePath(candidate: string, cwd: string): string | null {
  const cleaned = cleanCandidatePath(candidate)
  if (!cleaned || cleaned.includes('://')) return null
  const resolved = isAbsolute(cleaned)
    ? resolve(cleaned)
    : resolve(cwd, cleaned)
  if (!isWithinRoot(resolved, cwd) && !isAllowedExplicitExternalWriteTarget(resolved)) return null
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
  return extractWriteTargetPaths(toolName, input, cwd)[0] ?? null
}

function extractWriteTargetPaths(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): string[] {
  if (SHELL_ARTIFACT_TOOLS.has(toolName)) {
    const command = input['command']
    return typeof command === 'string'
      ? extractBashArtifactPaths(command, resolveToolCwd(input, cwd))
      : []
  }
  if (!isMutatingWriteTool(toolName)) return []
  const rawPath = toolName === 'NotebookEdit'
    ? input['notebook_path']
    : input['path']
  if (typeof rawPath !== 'string' || !rawPath.trim()) return []
  const resolved = isAbsolute(rawPath)
    ? resolve(rawPath)
    : resolve(cwd, rawPath)
  return [canonicalizePath(resolved)]
}

function isMutatingWriteTool(toolName: string): boolean {
  return MUTATING_WRITE_TOOLS.has(toolName)
}

function recordTouchedPath(taskState: TaskExecutionState, attemptedPath: string): void {
  if (!taskState.contract.touchedPaths.includes(attemptedPath)) {
    taskState.contract.touchedPaths.push(attemptedPath)
  }
  if (!taskState.contract.allowedWritePaths.some(
    (scope) => normalize(scope.path) === normalize(attemptedPath),
  )) {
    taskState.contract.allowedWritePaths.push({
      path: attemptedPath,
      kind: inferScopeKind(attemptedPath),
      origin: 'touched',
    })
  }
  taskState.contract.touchedPaths = dedupeStrings(taskState.contract.touchedPaths)
  taskState.contract.allowedWritePaths = dedupeScopes(taskState.contract.allowedWritePaths)
  taskState.contract.updatedAt = Date.now()
}

/**
 * Strip heredoc bodies from a shell command string so that HTML/text content
 * inside them is not mistaken for redirect targets (A2 fix).
 *
 * Supported forms:
 *   <<EOF ... EOF
 *   <<'EOF' ... EOF   (single-quoted delimiter — variable expansion disabled)
 *   <<"EOF" ... EOF   (double-quoted delimiter)
 *   <<-EOF ... EOF    (tab-stripped form)
 *
 * The delimiter may be any identifier-like string.  On termination the body
 * (everything from after the opener's newline to the end of the closing DELIM
 * line) is replaced with nothing so that subsequent redirects on the same
 * logical command are not disturbed.
 *
 * If a heredoc is unterminated (no matching DELIM line found), the entire
 * remainder of the command from the heredoc opener is blanked — we must not
 * parse any redirect targets that appear after the opener since we cannot
 * safely distinguish them from body content.
 */
function stripHeredocBodies(command: string): string {
  // Matches <<[-]?['"]?DELIM['"]?  — captures tab-stripped flag and delimiter.
  const heredocOpenerRe = /<<(-)?(['"]?)([A-Za-z_][A-Za-z0-9_]*)['"]?/g
  let result = command
  let searchOffset = 0

  while (true) {
    heredocOpenerRe.lastIndex = searchOffset
    const openerMatch = heredocOpenerRe.exec(result)
    if (!openerMatch) break

    const tabStripped = openerMatch[1] === '-'
    const delimiter = openerMatch[3]!
    const openerEnd = openerMatch.index + openerMatch[0].length

    // The body starts on the line AFTER the opener token
    const bodyStart = result.indexOf('\n', openerEnd)
    if (bodyStart === -1) {
      // Heredoc opener at end of string with no body newline — blank the rest
      result = result.slice(0, openerMatch.index)
      break
    }

    // Search for the terminating delimiter line
    let closingLineStart = -1
    let closingLineEnd = -1
    let scanPos = bodyStart + 1

    while (scanPos <= result.length) {
      const lineEnd = result.indexOf('\n', scanPos)
      const lineText = lineEnd === -1 ? result.slice(scanPos) : result.slice(scanPos, lineEnd)
      const trimmed = tabStripped ? lineText.replace(/^\t+/, '') : lineText
      if (trimmed === delimiter) {
        closingLineStart = scanPos
        closingLineEnd = lineEnd === -1 ? result.length : lineEnd + 1
        break
      }
      if (lineEnd === -1) {
        // Reached end without finding delimiter — unterminated heredoc
        break
      }
      scanPos = lineEnd + 1
    }

    if (closingLineStart === -1) {
      // Unterminated heredoc: blank everything from the opener onwards
      result = result.slice(0, openerMatch.index)
      break
    }

    // Remove the body (from after the opener's newline through the closing DELIM line)
    const before = result.slice(0, bodyStart + 1)
    const after = result.slice(closingLineEnd)
    result = before + after

    // Continue searching from the end of what we just kept
    searchOffset = before.length
    heredocOpenerRe.lastIndex = searchOffset
  }

  return result
}

function extractBashArtifactPaths(command: string, cwd: string): string[] {
  // A2 fix: strip heredoc bodies FIRST so that HTML tags / text content inside
  // them are never mistaken for redirect targets.
  const stripped = stripHeredocBodies(command)

  const paths: string[] = []
  const shellEnv = collectShellAssignments(stripped)
  const add = (raw: string | undefined): void => {
    for (const expanded of expandShellPath(raw, shellEnv)) {
      const cleaned = cleanShellPath(expanded)
      if (!cleaned) continue
      paths.push(canonicalizePath(isAbsolute(cleaned) ? resolve(cleaned) : resolve(cwd, cleaned)))
    }
  }

  for (const match of stripped.matchAll(/(?:^|[\s;&|])(?:\d*)>{1,2}\s*/g)) {
    add(readShellWord(stripped, (match.index ?? 0) + match[0].length)?.raw)
  }
  for (const match of stripped.matchAll(/\btee\b/g)) {
    for (const arg of nonOptionShellArgs(stripped, (match.index ?? 0) + match[0].length)) {
      add(arg)
    }
  }
  for (const match of stripped.matchAll(/\btouch\b/g)) {
    for (const arg of nonOptionShellArgs(stripped, (match.index ?? 0) + match[0].length)) {
      add(arg)
    }
  }
  for (const match of stripped.matchAll(/\bmkdir\b/g)) {
    for (const arg of nonOptionShellArgs(stripped, (match.index ?? 0) + match[0].length)) {
      add(arg)
    }
  }
  for (const match of stripped.matchAll(/\b(?:cp|mv)\b/g)) {
    const args = nonOptionShellArgs(stripped, (match.index ?? 0) + match[0].length)
    add(args.at(-1))
  }
  for (const match of stripped.matchAll(/(?:^|[\s;&|])--prefix(?:=|\s+)/g)) {
    add(readShellWord(stripped, (match.index ?? 0) + match[0].length)?.raw)
  }

  return dedupeStrings(paths)
}

function markArtifactProgress(taskState: TaskExecutionState): void {
  const now = Date.now()
  taskState.run.status = 'open'
  taskState.run.lastProgressAt = now
  taskState.run.lastArtifactProgressIteration = taskState.run.lifetimeIterations ?? 0
  taskState.run.lastGuardReason = null
  taskState.run.lastUpdatedAt = now
}

function extractToolProgressPaths(
  toolName: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined,
  cwd: string,
): string[] {
  const candidates: string[] = []
  if (toolName === 'TaskUpdate') {
    const touchedPaths = input['touchedPaths']
    if (Array.isArray(touchedPaths)) {
      for (const path of touchedPaths) {
        if (typeof path === 'string' && path.trim()) {
          candidates.push(resolveProgressPath(path, cwd))
        }
      }
    }
  }

  if (toolName === 'RunWorkspace' && input['action'] === 'recordArtifact' && typeof input['path'] === 'string') {
    candidates.push(resolveProgressPath(input['path'], cwd))
  }

  if (toolName === 'ArtifactVerify' && typeof input['deckPath'] === 'string') {
    candidates.push(resolveProgressPath(input['deckPath'], cwd))
  }

  const result = metadata?.['result']
  if (toolName === 'ArtifactVerify' && isRecordLike(result) && typeof result['artifactPath'] === 'string') {
    candidates.push(resolveProgressPath(result['artifactPath'], cwd))
  }

  return dedupeStrings(candidates)
}

function isExecutionProgressToolCall(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === 'TaskCreate' || toolName === 'TaskUpdate' || toolName === 'TaskVerify' || toolName === 'ArtifactVerify') {
    return true
  }
  if (toolName !== 'RunWorkspace') return false
  return input['action'] === 'create'
    || input['action'] === 'recordArtifact'
    || input['action'] === 'refreshLedger'
    || input['action'] === 'recordEvent'
    || input['action'] === 'writeCheckpoint'
}

function recordRunWorkspaceState(
  taskState: TaskExecutionState,
  toolName: string,
  metadata?: Record<string, unknown>,
): void {
  if (toolName !== 'RunWorkspace') return
  const action = typeof metadata?.['action'] === 'string' ? metadata['action'] : null
  const result = metadata?.['result']

  if (action === 'create' && isRecordLike(result)) {
    const manifest = result['manifest']
    const paths = result['paths']
    if (isRecordLike(manifest) && isRecordLike(paths)) {
      taskState.run.runWorkspace = {
        runId: typeof manifest['runId'] === 'string' ? manifest['runId'] : taskState.run.runWorkspace?.runId ?? 'unknown',
        outputRoot: typeof paths['outputRoot'] === 'string' ? paths['outputRoot'] : taskState.run.runWorkspace?.outputRoot ?? '',
        runDir: typeof paths['runDir'] === 'string' ? paths['runDir'] : taskState.run.runWorkspace?.runDir ?? '',
        manifestPath: typeof paths['manifestPath'] === 'string' ? paths['manifestPath'] : taskState.run.runWorkspace?.manifestPath ?? '',
        ...(typeof paths['checkpointPath'] === 'string' ? { checkpointPath: paths['checkpointPath'] } : {}),
        ...(typeof paths['artifactsPath'] === 'string' ? { artifactsPath: paths['artifactsPath'] } : {}),
        ...(typeof paths['eventsPath'] === 'string' ? { eventsPath: paths['eventsPath'] } : {}),
        createdAt: typeof manifest['createdAt'] === 'string' ? manifest['createdAt'] : new Date().toISOString(),
        artifactCount: 0,
        ...(typeof manifest['taskFamily'] === 'string' ? { taskFamily: manifest['taskFamily'] } : {}),
        ...(typeof manifest['deliverableMode'] === 'string' ? { deliverableMode: manifest['deliverableMode'] } : {}),
      }
    }
    return
  }

  if (!taskState.run.runWorkspace) return
  const now = new Date().toISOString()
  if (action === 'recordEvent' && isRecordLike(result) && typeof result['at'] === 'string') {
    taskState.run.runWorkspace.lastEventAt = result['at']
  } else if (action === 'writeCheckpoint') {
    taskState.run.runWorkspace.lastCheckpointAt = now
  } else if (
    (action === 'readLedger' || action === 'refreshLedger')
    && typeof metadata?.['artifactCount'] === 'number'
  ) {
    taskState.run.runWorkspace.artifactCount = metadata['artifactCount']
  } else if (action === 'recordArtifact') {
    taskState.run.runWorkspace.artifactCount = Math.max(taskState.run.runWorkspace.artifactCount ?? 0, 1)
  }
}

function recordDurableProgressPath(taskState: TaskExecutionState, candidate: string): boolean {
  const inWorkspace = isWithinRoot(candidate, taskState.contract.cwd)
  const inAllowedExternal = !inWorkspace
    && taskState.contract.allowedWritePaths.some(
      (scope) => scope.origin === 'user-external' && pathMatchesScope(candidate, scope),
    )
  if (!inWorkspace && !inAllowedExternal) return false
  recordTouchedPath(taskState, candidate)
  return true
}

function resolveProgressPath(pathToResolve: string, cwd: string): string {
  return canonicalizePath(isAbsolute(pathToResolve) ? resolve(pathToResolve) : resolve(cwd, pathToResolve))
}

function nonOptionShellArgs(command: string, startIndex: number): string[] {
  const args = readShellWordsUntilCommandBoundary(command, startIndex)
  return args.filter((arg) => arg && !arg.startsWith('-'))
}

function collectShellAssignments(command: string): Map<string, string> {
  const env = new Map<string, string>()
  for (const match of command.matchAll(/(?:^|[\n;&]\s*)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/g)) {
    const name = match[1]
    const word = readShellWord(command, (match.index ?? 0) + match[0].length)
    if (!name || !word) continue
    const expanded = expandShellVariables(word.raw, env)
    if (cleanShellPath(expanded)) {
      env.set(name, expanded)
    }
  }
  return env
}

function expandShellPath(raw: string | undefined, env: Map<string, string>): string[] {
  const value = raw?.trim()
  if (!value) return []
  return expandBracePath(expandShellVariables(value, env))
}

function expandShellVariables(value: string, env: Map<string, string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare
    if (!name) return match
    return env.get(name) ?? process.env[name] ?? match
  })
}

function expandBracePath(value: string): string[] {
  const match = /^(.*)\{([^{}]+)\}(.*)$/.exec(value)
  if (!match) return [value]
  const [, prefix = '', inner = '', suffix = ''] = match
  return inner
    .split(',')
    .map((part) => `${prefix}${part}${suffix}`)
    .filter((part) => part.trim().length > 0)
}

function readShellWordsUntilCommandBoundary(command: string, startIndex: number): string[] {
  const words: string[] = []
  let index = startIndex
  while (index < command.length) {
    index = skipShellInlineWhitespace(command, index)
    if (index >= command.length || isShellCommandBoundary(command[index]!) || command[index] === '<' || command[index] === '>') {
      break
    }
    const word = readShellWord(command, index)
    if (!word) break
    words.push(word.raw)
    index = word.end
  }
  return words
}

function readShellWord(command: string, startIndex: number): { raw: string; end: number } | null {
  let index = skipShellInlineWhitespace(command, startIndex)
  let raw = ''
  let quote: '"' | "'" | null = null
  while (index < command.length) {
    const ch = command[index]!
    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        raw += ch
      }
      index += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      index += 1
      continue
    }
    if (isShellCommandBoundary(ch) || ch === '<' || ch === '>' || /\s/.test(ch)) break
    raw += ch
    index += 1
  }
  return raw ? { raw, end: index } : null
}

function skipShellInlineWhitespace(command: string, startIndex: number): number {
  let index = startIndex
  while (index < command.length && (command[index] === ' ' || command[index] === '\t')) {
    index += 1
  }
  return index
}

function isShellCommandBoundary(ch: string): boolean {
  return ch === ';' || ch === '&' || ch === '|' || ch === '\n' || ch === '\r'
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolveToolCwd(input: Record<string, unknown>, fallbackCwd: string): string {
  const raw = input['cwd']
  if (typeof raw !== 'string' || !raw.trim()) return fallbackCwd
  return canonicalizePath(isAbsolute(raw) ? resolve(raw) : resolve(fallbackCwd, raw))
}

function cleanShellPath(raw: string | undefined): string | null {
  const value = raw?.trim()
  if (!value || value === '/dev/null') return null
  if (/[`$*?\[\]{}]/.test(value)) return null
  return value
}

function isScratchArtifactPath(path: string): boolean {
  return allowedExternalWriteRoots().some((root) => isWithinRoot(path, root))
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

function isAllowedExplicitExternalWriteTarget(candidatePath: string): boolean {
  const normalizedCandidate = canonicalizePath(candidatePath)
  return allowedExternalWriteRoots().some((root) => (
    normalizedCandidate === root || normalizedCandidate.startsWith(`${root}/`)
  ))
}

function allowedExternalWriteRoots(): string[] {
  return dedupeStrings([
    '/tmp',
    '/private/tmp',
    tmpdir(),
  ])
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
