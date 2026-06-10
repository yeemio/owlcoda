/**
 * Deliverable Contract Classifier — Slice 0, Deliverable Contract v1 (0.14.18+)
 *
 * Classifies the requested deliverable shape BEFORE progress gates fire.
 * This solves two distinct problems:
 *
 * 1. Read-only review / analysis / chat-summary tasks must NOT be hard-stopped
 *    solely because `touchedPaths.length === 0`.
 * 2. Durable file/code artifact tasks must still require artifact evidence
 *    before completion.
 *
 * Callsites MUST use the exported wrapper functions (isDurableArtifactDeliverable,
 * allowsChatFinal, shouldCreateStructuredTaskPlan, shouldHardStopOnNoTouchedPaths).
 * Do NOT inline `.mode === 'file_artifact_delivery'` at callsites — that bypasses
 * compound-intent arbitration, confidence gating, and future mode extensions.
 *
 * Priority chain (highest → lowest):
 *   code_change > file_artifact_delivery > command_job > text_deliverable
 *     > read_only_review > mixed_unknown
 *
 * Compound-intent: collect ALL mode signals first, then select the highest-priority
 * mode. mixed_unknown is reserved only for zero/weak signal — not for multi-mode hits.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeliverableMode =
  | 'read_only_review'
  | 'text_deliverable'
  | 'file_artifact_delivery'
  | 'code_change'
  | 'command_job'
  | 'mixed_unknown'

export type DeliverableConfidence = 'high' | 'medium' | 'low'

/**
 * Optional manifest hint for classifyDeliverableContract.
 * When provided with confidence !== 'low', the hint deliverableMode is adopted
 * directly; local signal collection still enriches matchedModes / signalSummary.
 */
export interface ManifestHint {
  deliverableMode: DeliverableMode
  confidence: DeliverableConfidence
}

export interface DeliverableSignalSummary {
  codeChange: string[]
  fileArtifact: string[]
  commandJob: string[]
  textDeliverable: string[]
  readOnlyReview: string[]
  pathLike: string[]
  explicitArtifactVerb: string[]
  artifactTypeOnly: string[]
}

export interface DeliverableContractClassification {
  mode: DeliverableMode
  confidence: DeliverableConfidence
  requiresDurableArtifact: boolean
  allowsChatFinal: boolean
  shouldCreateTaskPlan: boolean
  hardStopOnNoTouchedPaths: boolean
  reasons: string[]
  matchedModes: DeliverableMode[]
  signalSummary: DeliverableSignalSummary
}

// ---------------------------------------------------------------------------
// Priority ordering — higher index = higher priority
// ---------------------------------------------------------------------------

const MODE_PRIORITY: DeliverableMode[] = [
  'mixed_unknown',
  'read_only_review',
  'text_deliverable',
  'command_job',
  'file_artifact_delivery',
  'code_change',
]

function modePriority(mode: DeliverableMode): number {
  return MODE_PRIORITY.indexOf(mode)
}

function highestPriorityMode(modes: DeliverableMode[]): DeliverableMode {
  if (modes.length === 0) return 'mixed_unknown'
  return modes.reduce((a, b) => (modePriority(b) > modePriority(a) ? b : a))
}

function isDeliverableMode(value: unknown): value is DeliverableMode {
  return typeof value === 'string' && MODE_PRIORITY.includes(value as DeliverableMode)
}

// ---------------------------------------------------------------------------
// Signal regexes
// ---------------------------------------------------------------------------

// code_change signals: explicit code editing / fixing / implementing
// Note: Chinese terms don't use \b (CJK chars are not word chars in JS).
const CODE_CHANGE_RE = /(?:\bfix(?:ing)?\b|\bimplement(?:ing)?\b|\bpatch(?:ing)?\b|\brefactor(?:ing)?\b|\brename(?:ing)?\b|修复|修一下|补测试|提交\s*patch|实现)/i
// Explicit "edit/modify src/…" or backtick source path patterns
const CODE_CHANGE_PATH_RE = /(?:\b(?:edit|modify|update|change)\b|修改|改)[^.!?\n;；。！？]{0,80}(?:`[^`]+\.(?:[a-z]{1,5})`|(?:src|lib|tests?|packages?)\/\S+\.[a-z]{1,5})/i
// Also match: verb then backtick-path in code context (e.g. "修 `src/foo.ts`")
const CODE_CHANGE_BACKTICK_PATH_RE = /(?:修|改|edit|fix|patch)[^`\n]{0,30}`(?:src|lib|tests?|packages?|[A-Za-z0-9_.-]+\/)[^`]+\.[a-z]{1,10}`/i

// file_artifact_delivery: explicit output path with artifact suffix
const ARTIFACT_SUFFIX_RE = /(?:`[^`]*\.(?:html?|md|pdf|pptx?|docx?|json|csv|png|jpg|jpeg|svg|txt|xlsx?|zip|tar\.gz)`|(?:\.(?:html?|md|pdf|pptx?|docx?|json|csv|png|jpg|jpeg|svg|txt|xlsx?|zip))(?:\b|`))/i
// Output-ish path heuristic: /Users/.../output/... or path with artifact suffix
const OUTPUT_PATH_RE = /(?:`?(?:\/[A-Za-z0-9_.~-]+){3,}(?:\/output|\/dist|\/build|\/out|\/export|\/result)[^`\s]*`?)|(?:`?(?:\/[A-Za-z0-9_.~-]+){3,}\.(?:html?|md|pdf|pptx?|json|csv|png|jpg|svg)`?)/i
// Explicit write-to verbs
const ARTIFACT_WRITE_VERB_RE = /(?:保存到|落盘到|写入到|生成到|\boutput\s+to\b|\bsave\s+to\b|\bwrite\s+to\b|\bexport\s+to\b)/i
// Explicit destination "to docs/foo.md" or "into /path/file.ext" or "到 docs/foo.md"
const EXPLICIT_FILE_DEST_RE = /(?:\b(?:to|into|at|in)\s+|到\s*)[`'"]?(?:\.{0,2}\/|~\/|[A-Za-z0-9_.-]+\/)[^\s`'",;；。！？]+\.(?:md|html?|ts|tsx|js|jsx|json|py|yaml|yml|txt|css|pdf|pptx?|csv|png|svg)[`'"]?/i
// Chinese "到" or English "to/into" pointing to output directory (no file extension required)
const EXPLICIT_OUTPUT_DIR_DEST_RE = /(?:\b(?:to|into|output\s+to)|到\s*)[`'"]?(?:\/[A-Za-z0-9_.~-]+){2,}(?:[`'"]|\s|$)/i
// Artifact type keywords without path
const ARTIFACT_TYPE_KEYWORD_RE = /\b(?:HTML deck|PPT|slide deck|幻灯片|生成\s*(?:PPT|HTML)|generate\s+(?:a\s+)?(?:html|pdf|pptx?)\b)/i

// command_job signals — "run tests" / "跑测试" / etc.
// Note: CJK words don't have word boundaries in JS regex.
const COMMAND_JOB_RE = /(?:\brun\s+(?:the\s+)?tests?|\bexecute\s+command|\bcheck\s+build|跑\s*测试|运行测试|执行命令|检查构建|verify[^.!?\n]{0,60}output|把命令输出|命令输出告诉我)/i

// text_deliverable signals: write/generate text into chat
// "写一份技术方案" — allow intervening words between 写 and 方案
const TEXT_DELIVERABLE_RE = /(?:写[^。！？\n.!?]{0,10}(?:技术|实施|详细)?方案|写实施方案|总结|梳理|输出分析|写评审意见|\bdraft\s+a\s+plan|\bwrite\s+(?:a\s+)?(?:technical\s+)?(?:plan|spec|proposal|summary|analysis)|\bgive\s+(?:a\s+)?(?:summary|analysis|overview)|提供[^。！？\n.!?]{0,60}(?:分析|总结|评估|建议)|给出[^。！？\n.!?]{0,60}(?:分析|总结|评估|建议|报告))/i

// read_only_review signals: explicit read-only / review in chat
// Note: Chinese patterns don't use \b — word boundaries don't apply to CJK characters
const READ_ONLY_REVIEW_RE = /(?:只读评审|代码走读|技术评审|审视|分析一下|看下方案|结果在聊天里输出|不要求写文件|不要创建\s*artifact|\bread[- ]?only\s+(?:review|audit)|\blook\s+at\s+(?:this|the)|\bwhat[''']?s\s+wrong\s+with|看看[^。！？\n.!?]{0,30}有什么问题|\btell\s+me\s+what\s+is\s+wrong)/i

// Generic path-like (supporting signal only if no artifact suffix)
const GENERIC_PATH_RE = /`(?:\.{0,2}\/|~\/|[A-Za-z0-9_.-]+\/)[^`]+`|(?:^|[\s(])(?:\.{0,2}\/|~\/)[^\s,;；。！？"'`]{4,}/gm

// ---------------------------------------------------------------------------
// Classifier core
// ---------------------------------------------------------------------------

function collectSignals(text: string): DeliverableSignalSummary {
  const artifactSignalText = stripTracebackFileLines(text)
  const summary: DeliverableSignalSummary = {
    codeChange: [],
    fileArtifact: [],
    commandJob: [],
    textDeliverable: [],
    readOnlyReview: [],
    pathLike: [],
    explicitArtifactVerb: [],
    artifactTypeOnly: [],
  }

  if (CODE_CHANGE_RE.test(text)) summary.codeChange.push('code_change_verb')
  if (CODE_CHANGE_PATH_RE.test(text)) summary.codeChange.push('code_change_path')
  if (CODE_CHANGE_BACKTICK_PATH_RE.test(text)) summary.codeChange.push('code_change_backtick_path')

  if (ARTIFACT_SUFFIX_RE.test(artifactSignalText)) summary.fileArtifact.push('artifact_suffix')
  if (OUTPUT_PATH_RE.test(artifactSignalText)) summary.fileArtifact.push('output_path')
  if (EXPLICIT_FILE_DEST_RE.test(artifactSignalText)) summary.fileArtifact.push('explicit_file_dest')
  if (EXPLICIT_OUTPUT_DIR_DEST_RE.test(artifactSignalText)) summary.fileArtifact.push('explicit_output_dir_dest')
  if (ARTIFACT_WRITE_VERB_RE.test(artifactSignalText)) {
    summary.fileArtifact.push('artifact_write_verb')
    summary.explicitArtifactVerb.push('write_verb')
  }
  if (ARTIFACT_TYPE_KEYWORD_RE.test(artifactSignalText)) {
    summary.artifactTypeOnly.push('artifact_type_keyword')
  }

  if (COMMAND_JOB_RE.test(text)) summary.commandJob.push('command_job_verb')

  if (TEXT_DELIVERABLE_RE.test(text)) summary.textDeliverable.push('text_deliverable_verb')

  if (READ_ONLY_REVIEW_RE.test(text)) summary.readOnlyReview.push('read_only_review_verb')

  // Path-like supporting signals
  const pathMatches = text.matchAll(GENERIC_PATH_RE)
  for (const m of pathMatches) {
    summary.pathLike.push(m[0].trim().slice(0, 80))
  }

  return summary
}

function stripTracebackFileLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*File\s+["'][^"']+["'],\s+line\s+\d+\b/.test(line))
    .join('\n')
}

function determineModesFromSignals(
  signals: DeliverableSignalSummary,
): { modes: DeliverableMode[]; highConfidenceFileArtifact: boolean } {
  const modes: DeliverableMode[] = []
  let highConfidenceFileArtifact = false

  // code_change
  if (signals.codeChange.length > 0) {
    modes.push('code_change')
  }

  // file_artifact_delivery — high confidence if artifact suffix + output path, or explicit verb
  const hasArtifactSuffix = signals.fileArtifact.includes('artifact_suffix')
  const hasOutputPath = signals.fileArtifact.includes('output_path')
  const hasExplicitDest = signals.fileArtifact.includes('explicit_file_dest')
  const hasExplicitOutputDirDest = signals.fileArtifact.includes('explicit_output_dir_dest')
  const hasWriteVerb = signals.explicitArtifactVerb.length > 0
  const hasArtifactType = signals.artifactTypeOnly.length > 0

  if (hasArtifactSuffix || hasOutputPath || hasExplicitDest || hasExplicitOutputDirDest || hasWriteVerb) {
    modes.push('file_artifact_delivery')
    // High confidence:
    //   - artifact suffix + output-ish path (e.g. backtick path with .html + output dir)
    //   - explicit write verb + any path signal
    //   - explicit file dest (to docs/foo.md)
    //   - explicit output dir dest (到 /path/output/) + any other artifact signal
    //   - output-ish path alone (output/dist/build dir in path)
    if (
      (hasArtifactSuffix && hasOutputPath)
      || hasWriteVerb
      || hasExplicitDest
      || (hasExplicitOutputDirDest && (hasOutputPath || hasArtifactType || hasArtifactSuffix))
      || hasOutputPath
    ) {
      highConfidenceFileArtifact = true
    }
  } else if (hasArtifactType) {
    // Medium confidence: artifact type keyword but no path
    modes.push('file_artifact_delivery')
  }

  // command_job
  if (signals.commandJob.length > 0) {
    modes.push('command_job')
  }

  // text_deliverable
  if (signals.textDeliverable.length > 0) {
    modes.push('text_deliverable')
  }

  // read_only_review
  if (signals.readOnlyReview.length > 0) {
    modes.push('read_only_review')
  }

  return { modes, highConfidenceFileArtifact }
}

/**
 * Classify the deliverable mode from the request text.
 *
 * Collects ALL matching mode signals first, then arbitrates by priority.
 * Does NOT return on first phrase match.
 *
 * @param manifestHint — optional hint from RunWorkspace manifest. When present
 *   and confidence is not 'low', the hint can break ambiguous ties but cannot
 *   override an explicit source-code mutation target such as "修改 src/foo.ts".
 *   Local signal collection still runs so matchedModes / signalSummary are
 *   enriched for telemetry.
 */
export function classifyDeliverableContract(
  text: string,
  opts?: { manifestHint?: ManifestHint },
): DeliverableContractClassification {
  const trimmed = text.trim()
  const hint = opts?.manifestHint

  if (trimmed === '') {
    const empty: DeliverableSignalSummary = {
      codeChange: [], fileArtifact: [], commandJob: [], textDeliverable: [],
      readOnlyReview: [], pathLike: [], explicitArtifactVerb: [], artifactTypeOnly: [],
    }
    // Even for empty text: if a valid strong manifest hint exists, honour it.
    if (isUsableManifestHint(hint)) {
      return buildResult(hint.deliverableMode, hint.confidence, [hint.deliverableMode], empty, [
        `manifest_hint:${hint.deliverableMode}/${hint.confidence} (empty text)`,
      ])
    }
    return buildResult('mixed_unknown', 'low', [], empty, ['empty text'])
  }

  const signals = collectSignals(trimmed)
  const { modes, highConfidenceFileArtifact } = determineModesFromSignals(signals)

  // Deduplicate matched modes
  const uniqueModes = [...new Set(modes)]

  // ------------------------------------------------------------------
  // A1.主修: manifest hint can win when confidence is not 'low', but only
  // when it does not contradict a strong explicit source-code mutation target.
  // A RunWorkspace manifest is runtime-derived state, not a user permission to
  // reclassify "修改 src/foo.ts" as file-artifact work.
  // ------------------------------------------------------------------
  if (canUseManifestHint(hint, signals)) {
    const hintModes = uniqueModes.includes(hint.deliverableMode)
      ? uniqueModes
      : [hint.deliverableMode, ...uniqueModes]
    return buildResult(hint.deliverableMode, hint.confidence, hintModes, signals, [
      `manifest_hint:${hint.deliverableMode}/${hint.confidence}`,
      ...(uniqueModes.length > 0
        ? [`local signals matched: ${uniqueModes.join(', ')}`]
        : ['no local mode signals detected']),
    ])
  }

  if (uniqueModes.length === 0) {
    // Zero strong signals → mixed_unknown/low
    return buildResult('mixed_unknown', 'low', [], signals, ['no strong signals detected'])
  }

  // ------------------------------------------------------------------
  // A1.次修: explicit output path for file_artifact beats code_change
  // triggered only by weak "model read code-shaped files" signals.
  //
  // Condition (ALL must hold):
  //   1. file_artifact_delivery is present AND has output-destination signals
  //      (artifact_write_verb or output_path — NOT just explicit_file_dest alone,
  //      since "\bin\s+src/foo.ts" fires explicit_file_dest but is a code reference)
  //   2. code_change has ONLY verb signals — no explicit src/ path reference
  //      (code_change_path or code_change_backtick_path would indicate a genuine
  //      code-mutation intent, e.g. "修改 src/foo.ts")
  // ------------------------------------------------------------------
  const hasOutputDestinationSignal =
    signals.explicitArtifactVerb.length > 0           // e.g. "output to", "save to", "写入到"
    || signals.fileArtifact.includes('output_path')   // output/dist/build dir in path
  let effectiveModes = uniqueModes
  if (
    uniqueModes.includes('file_artifact_delivery')
    && uniqueModes.includes('code_change')
    && highConfidenceFileArtifact
    && hasOutputDestinationSignal
    && signals.codeChange.length > 0
    && !signals.codeChange.includes('code_change_path')
    && !signals.codeChange.includes('code_change_backtick_path')
  ) {
    // Demote code_change: remove it so file_artifact_delivery wins priority
    effectiveModes = uniqueModes.filter((m) => m !== 'code_change')
  }

  // Compound-intent: select highest priority mode
  const selectedMode = highestPriorityMode(effectiveModes)
  const reasons: string[] = [`selected ${selectedMode} from matched modes: ${uniqueModes.join(', ')}`]
  if (effectiveModes.length !== uniqueModes.length) {
    reasons.push('code_change demoted: explicit output path overrides weak code_change verb signal')
  }

  // Determine confidence for the selected mode
  let confidence: DeliverableConfidence = 'medium'

  if (selectedMode === 'code_change') {
    confidence = 'high'
  } else if (selectedMode === 'file_artifact_delivery') {
    confidence = highConfidenceFileArtifact ? 'high' : 'medium'
    if (!highConfidenceFileArtifact) {
      reasons.push('medium confidence: artifact type without explicit path or write verb')
    }
  } else if (selectedMode === 'command_job') {
    confidence = 'high'
  } else if (selectedMode === 'text_deliverable') {
    confidence = 'high'
  } else if (selectedMode === 'read_only_review') {
    confidence = 'high'
  }

  return buildResult(selectedMode, confidence, uniqueModes, signals, reasons)
}

function isUsableManifestHint(hint: ManifestHint | undefined): hint is ManifestHint {
  return (
    hint !== undefined
    && hint.confidence !== 'low'
    && isDeliverableMode(hint.deliverableMode)
    && hint.deliverableMode !== 'mixed_unknown'
  )
}

function canUseManifestHint(
  hint: ManifestHint | undefined,
  signals: DeliverableSignalSummary,
): hint is ManifestHint {
  if (!isUsableManifestHint(hint)) return false
  const hasExplicitCodeMutationTarget =
    signals.codeChange.includes('code_change_path')
    || signals.codeChange.includes('code_change_backtick_path')
  if (hasExplicitCodeMutationTarget && hint.deliverableMode !== 'code_change') {
    return false
  }
  return true
}

function buildResult(
  mode: DeliverableMode,
  confidence: DeliverableConfidence,
  matchedModes: DeliverableMode[],
  signalSummary: DeliverableSignalSummary,
  reasons: string[],
): DeliverableContractClassification {
  const isDurable = mode === 'code_change' || mode === 'file_artifact_delivery'
  // Hard stop only for high-confidence durable artifact modes
  const hardStop = isDurable && confidence === 'high'

  return {
    mode,
    confidence,
    requiresDurableArtifact: isDurable,
    allowsChatFinal: !isDurable || !hardStop,
    shouldCreateTaskPlan: isDurable && confidence !== 'low',
    hardStopOnNoTouchedPaths: hardStop,
    reasons,
    matchedModes,
    signalSummary,
  }
}

// ---------------------------------------------------------------------------
// Canonical wrapper functions — callsites MUST use these, not inline .mode ===
// ---------------------------------------------------------------------------

/**
 * Returns true for high-confidence durable artifact modes (code_change,
 * file_artifact_delivery/high). Used to decide whether progress gates apply.
 */
export function isDurableArtifactDeliverable(
  contract: DeliverableContractClassification,
): boolean {
  return contract.requiresDurableArtifact && contract.confidence === 'high'
}

/**
 * Returns true when the task requires durable artifact progress (touched paths).
 * Equivalent to: high-confidence code_change or file_artifact_delivery.
 */
export function taskRequiresDurableProgress(
  contract: DeliverableContractClassification,
): boolean {
  return isDurableArtifactDeliverable(contract)
}

/**
 * Returns true when the task is allowed to complete in chat without touched paths.
 * text_deliverable, read_only_review, command_job, mixed_unknown all return true.
 * file_artifact_delivery/high and code_change return false.
 */
export function allowsChatFinal(
  contract: DeliverableContractClassification,
): boolean {
  return contract.allowsChatFinal
}

/**
 * Returns true when a structured task plan (with steps, verification) should be
 * created. Only for durable artifact modes with medium+ confidence.
 */
export function shouldCreateStructuredTaskPlan(
  contract: DeliverableContractClassification,
): boolean {
  return contract.shouldCreateTaskPlan
}

/**
 * Returns true when the task_no_progress hard stop should fire if touchedPaths=0
 * after the iteration limit. Only for high-confidence durable artifact modes.
 */
export function shouldHardStopOnNoTouchedPaths(
  contract: DeliverableContractClassification,
): boolean {
  return contract.hardStopOnNoTouchedPaths
}
