import type { ToolCallTraceEntry } from '../native/transcript-trace.js'

export const BENCHMARK_CASE_IDS = [
  'deck-46p',
  'deck-12p',
  'code-fix-tests',
  'readonly-review',
  'research-note',
  'data-report',
  'deck-46p-realistic',
  'smoke-provenance-article',
  'smoke-provenance-known-file',
] as const

export type BenchmarkCaseId = typeof BENCHMARK_CASE_IDS[number]

export type BenchmarkTaskFamily =
  | 'deck'
  | 'code'
  | 'read_only_review'
  | 'research'
  | 'data_report'

export type BenchmarkDeliverableMode =
  | 'file_artifact_delivery'
  | 'code_change'
  | 'read_only_review'
  | 'text_deliverable'

export type BenchmarkFinalStatus = 'passed' | 'failed' | 'blocked'

export type BenchmarkVerificationStatus = 'passed' | 'failed' | 'blocked' | 'not_run'

export interface BenchmarkArtifact {
  path: string
  kind: string
  exists: boolean
  bytes?: number
  source?: 'dry_run' | 'write' | 'edit' | 'bash' | 'chat'
  notes?: string
}

export interface BenchmarkVerification {
  id: string
  kind: string
  status: BenchmarkVerificationStatus
  passed: boolean
  message: string
  expected?: string | number | boolean | null
  actual?: string | number | boolean | null
}

export interface BenchmarkTaskNoProgress {
  hard: number
  suppressed: number
}

export type BenchmarkEvalAuditField =
  | 'artifact_list'
  | 'final_status'
  | 'section_count'
  | 'task_no_progress'
  | 'timeout_sentinel'
  | 'tool_sequence'
  | 'verification_results'

export type BenchmarkEvalComparisonHarness =
  | 'scripted_mock'
  | 'provider_api'
  | 'expect_tui'

export interface BenchmarkEvalSectionPolicy {
  smokeMinSections?: number
  heavyExactSections?: number
  exactSectionsGate: 'release_smoke' | 'heavy_eval'
}

export interface BenchmarkEvalPolicy {
  /**
   * Exact output paths as task-prompt templates. Use __WORKSPACE__ so the
   * runner can render absolute paths without leaking local temp dirs into
   * committed fixtures.
   */
  expectedArtifactPaths: string[]
  /** Runtime observations collected by the wrapper, not shown to the model. */
  auditFields: BenchmarkEvalAuditField[]
  /** Wrapper timeout budget for real provider evals. */
  timeoutMs: number
  /** How the wrapper decides the task is still alive during long runs. */
  keepalive: 'progress_sentinel' | 'scripted_mock'
  /** How this case can be run reproducibly outside the interactive TUI. */
  comparisonHarness: BenchmarkEvalComparisonHarness
  sectionPolicy?: BenchmarkEvalSectionPolicy
  /**
   * Per-case process.env overrides applied for the duration of the live run
   * and restored in finally. Use for runtime gate flags whose default would
   * keep the case inert (e.g. OWLCODA_GATE_PROVENANCE for provenance smoke).
   */
  envOverrides?: Record<string, string>
}

export interface BenchmarkDryRunResult {
  caseId: BenchmarkCaseId
  packageVersion: string
  binaryBuild: string
  selectedSkill: string | null
  timeToFirstWriteMs: number
  readCallsBeforeFirstWrite: number
  artifacts: BenchmarkArtifact[]
  verification: BenchmarkVerification[]
  taskNoProgress: BenchmarkTaskNoProgress
  finalStatus: BenchmarkFinalStatus
  /** Golden tool-call trace for regression (S7). Optional: only when a fixture
   *  declares it does the runner diff the actual run's trace against it. */
  trace?: ToolCallTraceEntry[]
}

export interface BenchmarkCaseFixture {
  caseId: BenchmarkCaseId
  title: string
  taskFamily: BenchmarkTaskFamily
  deliverableMode: BenchmarkDeliverableMode
  prompt: string
  expectedOutputs: string[]
  evalPolicy: BenchmarkEvalPolicy
  dryRun: Omit<BenchmarkDryRunResult, 'caseId' | 'packageVersion' | 'binaryBuild'> & {
    /**
     * Scripted model responses for the live runner (0.14.24).
     * When absent the runner marks the case as 'skipped: needs mock trajectory'.
     */
    mockResponseSequence?: ScriptedResponse[]
  }
}

export interface BenchmarkSchemaValidation {
  ok: boolean
  issues: string[]
}

// ---------------------------------------------------------------------------
// Live-runner scripted response types (0.14.24)
// ---------------------------------------------------------------------------

export interface ScriptedToolCall {
  toolName: string
  input: Record<string, unknown>
}

export interface ScriptedResponse {
  /** The text portion of the assistant message (may be empty if tool_use only). */
  text: string
  toolUse?: ScriptedToolCall[]
  stopReason: 'end_turn' | 'tool_use'
  /** Mock token usage. Defaults to { input_tokens: 5, output_tokens: 5 } when omitted. */
  usage?: { input_tokens: number; output_tokens: number }
}
