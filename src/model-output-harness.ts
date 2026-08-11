import { createHash } from 'node:crypto'
import type {
  StructuredOutputExecutionBudget,
  StructuredOutputExecutionCounts,
  StructuredOutputExecutionReceipt,
} from './structured-output-execution-economics.js'
import type { RuntimeExecutionResult } from './native/runtime-execution-control/types.js'

export type BuiltinStructuredOutputPreset =
  | 'evidence-digest.v1'
  | 'analyst-audit.v1'
  | 'canonical-judge.v1'

export type StructuredOutputPreset =
  | BuiltinStructuredOutputPreset
  | (string & {})

export type StructuredOutputAttemptLabel = 'primary' | 'parse' | 'repair' | 'salvage' | 'fallback'

export type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'

export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[]
  required?: string[]
  properties?: Record<string, JsonSchema>
  additionalProperties?: boolean | JsonSchema
  items?: JsonSchema
  enum?: unknown[]
  const?: unknown
}

export interface StructuredOutputRepairPolicy {
  enabled?: boolean
  maxAttempts?: number
}

export interface StructuredOutputSalvagePolicy {
  enabled?: boolean
  fields?: string[]
}

export interface StructuredOutputPolicy {
  forbiddenPhrases?: string[]
  forbiddenPhraseAction?: 'reject' | 'sanitize_to_risks'
  maxArrayItems?: number
  maxStringLength?: number
}

export type StructuredOutputCapabilityStatus = 'supported' | 'unsupported' | 'unknown'
export type StructuredOutputCapabilitySource = 'declared' | 'probed' | 'manual' | 'fallback'
export type StructuredOutputThinkingBehavior = 'text_and_thinking' | 'thinking_only_risk' | 'unknown'
export type StructuredOutputTerminationKind =
  | 'completed'
  | 'silent_timeout'
  | 'hard_timeout'
  | 'provider_error'
  | 'aborted'
  | 'unknown'

export const STRUCTURED_OUTPUT_FAILURE_REASONS = [
  'output_budget_exhausted',
  'schema_validation_failed',
  'parse_failed',
  'empty_text',
  'empty_text_with_thinking',
  'locale_mismatch',
  'silent_timeout',
  'hard_timeout',
  'model_call_failed',
  'capability_json_unsupported',
  'capability_gate_failed',
  'aborted',
  'runtime_execution_failed',
  'policy_violation',
  'failed_fallback',
  'missing_required_artifact',
] as const

export type StructuredOutputFailureReason = typeof STRUCTURED_OUTPUT_FAILURE_REASONS[number]

export type StructuredOutputDeltaKind = 'text' | 'content' | 'thinking' | 'heartbeat'

export interface StructuredOutputDelta {
  type?: StructuredOutputDeltaKind
  text?: string
}

export interface StructuredOutputSupportCapability {
  status: StructuredOutputCapabilityStatus
  source: StructuredOutputCapabilitySource
  reason?: string
}

export interface StructuredOutputTokenCapability {
  tokens: number
  source: StructuredOutputCapabilitySource
}

export interface StructuredOutputThinkingCapability {
  behavior: StructuredOutputThinkingBehavior
  source: StructuredOutputCapabilitySource
  reason?: string
}

export interface StructuredOutputModelCapabilities {
  jsonMode: StructuredOutputSupportCapability
  maxContextTokens: StructuredOutputTokenCapability
  maxOutputTokens: StructuredOutputTokenCapability
  streaming: StructuredOutputSupportCapability
  thinking: StructuredOutputThinkingCapability
}

export interface StructuredOutputCapabilityGateResult {
  ok: boolean
  source: StructuredOutputCapabilitySource
  requestedMaxTokens: number
  appliedMaxTokens: number
  errors: string[]
  warnings: string[]
  modelCapabilities?: StructuredOutputModelCapabilities
}

export interface StructuredOutputPresetContract {
  artifact: BuiltinStructuredOutputPreset
  presetId: string
  presetVersion: string
  schemaId: string
  schemaVersion: string
  system: string
  schema: JsonSchema
  policy: StructuredOutputPolicy
  salvagePolicy: StructuredOutputSalvagePolicy
  maxTokens?: number
}

export interface ProviderPresetMatrixEntry {
  presetId: 'evidence-digest' | 'analyst-audit' | 'canonical-judge'
  presetVersion: string
  provider: string
  modelPattern: string
  maxTokens: number
  temperature: number
  idleTimeoutMs: number
  hardTimeoutMs: number
  repairPolicy: string
  salvagePolicy: string
  forceLocale?: string
  outputDiscipline: string
}

export interface ProviderPresetMatrix {
  version: 'provider-preset-matrix.v1'
  presets: ProviderPresetMatrixEntry[]
}

export type StructuredOutputEffectiveControl = 'maxTokens' | 'temperature' | 'idleTimeoutMs' | 'hardTimeoutMs' | 'forceLocale'
export type StructuredOutputControlSource = 'request' | 'provider_matrix' | 'preset_default'

export interface ProviderMatrixOverride {
  source: 'request'
  value: number | string
  matrixValue?: number | string
  presetValue?: number | string
}

export interface ProviderMatrixProvenance {
  providerMatrixVersion: string
  providerMatrixEntryId: string | null
  providerMatrixEntryHash: string | null
  matched: boolean
  applied: boolean
  appliedControls: StructuredOutputEffectiveControl[]
  overrides: Partial<Record<StructuredOutputEffectiveControl, ProviderMatrixOverride>>
  controlSources: Partial<Record<StructuredOutputEffectiveControl, StructuredOutputControlSource>>
  policyVersions: {
    repairPolicy: string | null
    salvagePolicy: string | null
    outputDiscipline: string | null
  }
}

export interface StructuredOutputRequest {
  model: string
  preset?: StructuredOutputPreset
  schema?: JsonSchema
  system?: string
  user: string
  maxTokens?: number
  temperature?: number
  repairPolicy?: StructuredOutputRepairPolicy
  salvagePolicy?: StructuredOutputSalvagePolicy
  policy?: StructuredOutputPolicy
  persist?: boolean
  runRef?: string
  role?: string
  forceLocale?: string
  force_locale?: string
  idleTimeoutMs?: number
  hardTimeoutMs?: number
  presetId?: string
  presetVersion?: string
  schemaId?: string
  schemaVersion?: string
  threadId?: string
  turnId?: string
  runId?: string
  taskId?: string
  stepId?: string
  jobId?: string
  proofId?: string
  previousArtifactId?: string
  inputRef?: string
  artifactRef?: string
  modelCapabilities?: StructuredOutputModelCapabilities
  providerMatrixProvenance?: ProviderMatrixProvenance
  executionBudget?: StructuredOutputExecutionBudget
  idempotencyKey?: string
  intentionalRepeat?: boolean
  signal?: AbortSignal
  executorKind?: 'runtime-driver'
}

export interface StructuredOutputExecutorRequest extends StructuredOutputRequest {
  preset: StructuredOutputPreset
  system: string
  maxTokens: number
  onOutputDelta?: (delta: StructuredOutputDelta) => void
  onRuntimeExecution?: (result: RuntimeExecutionResult) => void
}

export interface StructuredOutputModelResponse {
  text: string
  thinkingText?: string
  stopReason?: string | null
  inputTokens?: number
  outputTokens?: number
  durationMs?: number
  streamingMode?: 'streaming' | 'non_streaming'
  streamDeltaSource?: 'provider_sse' | 'translated_sse' | 'none'
  runtimeExecution?: RuntimeExecutionResult
}

export type StructuredOutputExecutor = (
  request: StructuredOutputExecutorRequest,
) => Promise<StructuredOutputModelResponse>

export interface StructuredOutputExecutionLimits {
  maxTokens?: number
  hardTimeoutMs?: number
}

export interface StructuredOutputAttempt {
  label: StructuredOutputAttemptLabel
  model: string
  durationMs: number
  inputTokens: number
  outputTokens: number
  stopReason: string | null
  parsed: boolean
  schemaValid: boolean
  error?: string
  failureReason?: StructuredOutputFailureReason
  requestedTemperature?: number
  appliedTemperature?: number
  temperatureSource?: StructuredOutputControlSource
  providerMatrixProvenance?: ProviderMatrixProvenance
  terminationKind?: StructuredOutputTerminationKind
  lastOutputAt?: string
  idleMs?: number
  partialText?: string
  streamingMode?: 'streaming' | 'non_streaming'
  streamDeltaSource?: 'provider_sse' | 'translated_sse' | 'none'
  runtimeExecution?: RuntimeExecutionResult
}

export type ArtifactCompletenessValidationStatus = 'pass' | 'warn' | 'fail' | 'unknown'
export type ArtifactCompletenessFallbackStatus = 'none' | 'repair' | 'salvage' | 'failed_fallback'

export interface ArtifactCompletenessReceipt {
  expected: string[]
  produced: string[]
  missing: string[]
  validationStatus: ArtifactCompletenessValidationStatus
  fallbackStatus: ArtifactCompletenessFallbackStatus
  artifactRefs: Array<{
    artifactId: string
    kind: string
    path?: string
    ref?: string
  }>
  attemptLedgerRef?: string
}

export interface ConsumerReadinessGate {
  consumerReady: boolean
  blockers: Array<{ code: string; message: string; ref?: string }>
  warnings: Array<{ code: string; message: string; ref?: string }>
  requiredArtifactsMissing: string[]
  fallbackUsed: boolean
  usable: boolean
}

export interface StructuredOutputSalvageReceipt {
  used: boolean
  fields: Record<string, unknown>
  missingRequiredFields: string[]
  confidence: 'high' | 'medium' | 'low'
  reason?: string
}

export interface StructuredOutputResponse {
  ok: boolean
  artifact: Record<string, unknown>
  /** Compatibility alias for HTTP consumers that expect a data payload. */
  data: Record<string, unknown>
  rawText: string
  rawThinkingText?: string
  usable: boolean
  failureReason?: StructuredOutputFailureReason
  unusableReason?: StructuredOutputFailureReason
  salvage: StructuredOutputSalvageReceipt
  artifactCompleteness: ArtifactCompletenessReceipt
  consumerReady: boolean
  consumerReadiness: ConsumerReadinessGate
  terminationKind: StructuredOutputTerminationKind
  lastOutputAt?: string
  idleMs?: number
  presetId: string
  presetVersion: string
  schemaId: string
  schemaVersion: string
  repairPolicyVersion: string
  providerMatrixVersion: string
  providerMatrixProvenance: ProviderMatrixProvenance
  parsed: boolean
  schemaValid: boolean
  validationErrors: string[]
  attempts: StructuredOutputAttempt[]
  repairCount: number
  salvageUsed: boolean
  fallbackUsed: boolean
  stopReason: string | null
  inputTokens: number
  outputTokens: number
  durationMs: number
  persisted?: boolean
  artifactId?: string
  attemptLedgerId?: string
  runRef?: string
  rerun?: boolean
  parentArtifactId?: string
  rerunOf?: string
  inputRef?: string
  artifactRef?: string
  capabilityGate?: StructuredOutputCapabilityGateResult
  executionCounts?: StructuredOutputExecutionCounts
  executionEconomics?: StructuredOutputExecutionReceipt
  idempotency?: {
    key: string
    requestHash: string
    replayed: boolean
    namespace: 'primary' | 'rerun'
  }
  runtimeExecution?: RuntimeExecutionResult
}

export const STRUCTURED_OUTPUT_PRESETS: Record<BuiltinStructuredOutputPreset, StructuredOutputPresetContract> = {
  'evidence-digest.v1': {
    artifact: 'evidence-digest.v1',
    presetId: 'evidence-digest',
    presetVersion: 'v1',
    schemaId: 'evidence-digest',
    schemaVersion: 'v1',
    system:
      'Return exactly one short JSON object. Do not include chain-of-thought, markdown, or prose outside JSON.',
    schema: {
      type: 'object',
      required: ['artifact', 'summary', 'confidence'],
      properties: {
        role: { type: 'string' },
        artifact: { const: 'evidence-digest.v1' },
        summary: { type: 'string' },
        confidence: { type: 'number' },
        source_refs: { type: 'array', items: { type: 'string' } },
        evidence_items: { type: 'array', items: { type: 'object' } },
        source_quality: { type: 'string' },
        risks: { type: 'array', items: { type: 'string' } },
        data_quality: { type: 'string' },
        market_coverage: { type: 'string' },
        data_gaps: { type: 'array', items: { type: 'string' } },
      },
    },
    policy: {
      forbiddenPhrases: ['chain-of-thought', '思考过程', '推理过程'],
      maxArrayItems: 12,
      maxStringLength: 1200,
    },
    salvagePolicy: {
      enabled: true,
      fields: ['artifact', 'summary', 'confidence', 'source_refs', 'risks', 'data_gaps'],
    },
    maxTokens: 1200,
  },
  'analyst-audit.v1': {
    artifact: 'analyst-audit.v1',
    presetId: 'analyst-audit',
    presetVersion: 'v1',
    schemaId: 'analyst-audit',
    schemaVersion: 'v1',
    system:
      'Consume the provided artifact only. Return exactly one JSON object with conflicts, gaps, assumptions, and candidate findings. Do not make a final judgment.',
    schema: {
      type: 'object',
      required: ['artifact', 'candidate_findings', 'conflicts', 'gaps', 'assumptions', 'confidence'],
      properties: {
        artifact: { const: 'analyst-audit.v1' },
        candidate_findings: { type: 'array', items: { type: 'string' } },
        conflicts: { type: 'array', items: { type: 'string' } },
        gaps: { type: 'array', items: { type: 'string' } },
        assumptions: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'number' },
      },
    },
    policy: {
      forbiddenPhrases: ['chain-of-thought', '思考过程', '推理过程', 'final judgment'],
      maxArrayItems: 12,
      maxStringLength: 1200,
    },
    salvagePolicy: {
      enabled: true,
      fields: ['artifact', 'candidate_findings', 'conflicts', 'gaps', 'assumptions', 'confidence'],
    },
    maxTokens: 1200,
  },
  'canonical-judge.v1': {
    artifact: 'canonical-judge.v1',
    presetId: 'canonical-judge',
    presetVersion: 'v1',
    schemaId: 'canonical-judge',
    schemaVersion: 'v1',
    system:
      'Consume the provided compressed artifacts only. Return exactly one canonical JSON object. Do not fetch or reread long evidence.',
    schema: {
      type: 'object',
      required: ['artifact', 'decision', 'confidence', 'evidence_refs', 'conflicts'],
      properties: {
        artifact: { const: 'canonical-judge.v1' },
        decision: { type: 'string' },
        confidence: { type: 'number' },
        rationale_summary: { type: 'string' },
        evidence_refs: { type: 'array', items: { type: 'string' } },
        conflicts: { type: 'array', items: { type: 'string' } },
      },
    },
    policy: {
      forbiddenPhrases: ['chain-of-thought', '思考过程', '推理过程'],
      maxArrayItems: 12,
      maxStringLength: 1200,
    },
    salvagePolicy: {
      enabled: true,
      fields: ['artifact', 'decision', 'confidence', 'rationale_summary', 'evidence_refs', 'conflicts'],
    },
    maxTokens: 1200,
  },
}

export const PROVIDER_PRESET_MATRIX: ProviderPresetMatrix = {
  version: 'provider-preset-matrix.v1',
  presets: [
    {
      presetId: 'evidence-digest',
      presetVersion: 'v1',
      provider: 'kimi',
      modelPattern: 'kimi|moonshot',
      maxTokens: 20_480,
      temperature: 0.2,
      idleTimeoutMs: 45_000,
      hardTimeoutMs: 900_000,
      repairPolicy: 'repair-policy.v1',
      salvagePolicy: 'salvage-policy.v1',
      forceLocale: 'zh-CN',
      outputDiscipline: 'json_only_no_cot_raw_preserved',
    },
    {
      presetId: 'analyst-audit',
      presetVersion: 'v1',
      provider: 'deepseek',
      modelPattern: 'deepseek',
      maxTokens: 8192,
      temperature: 0.3,
      idleTimeoutMs: 30_000,
      hardTimeoutMs: 300_000,
      repairPolicy: 'repair-policy.v1',
      salvagePolicy: 'salvage-policy.v1',
      outputDiscipline: 'json_only_audit_no_final_judgment',
    },
    {
      presetId: 'canonical-judge',
      presetVersion: 'v1',
      provider: 'openai',
      modelPattern: 'gpt|openai',
      maxTokens: 8192,
      temperature: 0,
      idleTimeoutMs: 30_000,
      hardTimeoutMs: 300_000,
      repairPolicy: 'repair-policy.v1',
      salvagePolicy: 'salvage-policy.v1',
      outputDiscipline: 'canonical_json_only',
    },
  ],
}

const resolvedStructuredOutputContracts = new WeakMap<StructuredOutputRequest, string>()

export function getStructuredOutputPresetContract(
  preset: StructuredOutputPreset | undefined,
): StructuredOutputPresetContract | undefined {
  const resolvedPreset = preset ?? 'evidence-digest.v1'
  return STRUCTURED_OUTPUT_PRESETS[resolvedPreset as BuiltinStructuredOutputPreset]
}

export function structuredOutputRequestContractErrors(request: StructuredOutputRequest): string[] {
  const preset = request.preset ?? 'evidence-digest.v1'
  const contract = getStructuredOutputPresetContract(preset)
  const canonicalPreset = versionPartsFromPreset(preset)
  if (contract && request.schema) {
    return ['built-in preset cannot be combined with a custom schema']
  }
  const conflictingPresetIdentity = [
    ['presetId', request.presetId, canonicalPreset.presetId],
    ['presetVersion', request.presetVersion, canonicalPreset.presetVersion],
  ].find(([, provided, canonical]) => provided !== undefined && provided.trim() !== canonical)
  if (conflictingPresetIdentity) {
    const [field, provided, canonical] = conflictingPresetIdentity
    const error = `${field}=${provided}, expected ${canonical}`
    return [contract
      ? `built-in preset identity conflicts with canonical contract: ${error}`
      : `preset identity conflicts with canonical preset: ${error}`]
  }
  if (contract) {
    const conflictingSchemaIdentity = [
      ['schemaId', request.schemaId, contract.schemaId],
      ['schemaVersion', request.schemaVersion, contract.schemaVersion],
    ].find(([, provided, canonical]) => provided !== undefined && provided.trim() !== canonical)
    if (conflictingSchemaIdentity) {
      const [field, provided, canonical] = conflictingSchemaIdentity
      return [`built-in preset identity conflicts with canonical contract: ${field}=${provided}, expected ${canonical}`]
    }
  }
  if (!contract) {
    const errors: string[] = []
    if (!request.schema) errors.push('custom preset requires an explicit schema')
    if (!request.schemaId?.trim() || !request.schemaVersion?.trim()) {
      errors.push('custom preset requires explicit schemaId and schemaVersion')
    }
    if (!request.system?.trim()) errors.push('custom preset requires an explicit system')
    if (!request.policy) errors.push('custom preset requires an explicit policy')
    if (request.maxTokens === undefined) errors.push('custom preset requires an explicit maxTokens budget')
    const impersonatedBuiltin = Object.values(STRUCTURED_OUTPUT_PRESETS).find(candidate =>
      request.schemaId?.trim() === candidate.schemaId
      && request.schemaVersion?.trim() === candidate.schemaVersion,
    )
    if (impersonatedBuiltin) errors.push('custom schema identity conflicts with built-in contract')
    return errors
  }
  return []
}

export function resolveStructuredOutputContract(request: StructuredOutputRequest): StructuredOutputRequest {
  const errors = structuredOutputRequestContractErrors(request)
  if (errors.length > 0) throw new Error(errors.join('; '))
  const preset = request.preset ?? 'evidence-digest.v1'
  const contract = getStructuredOutputPresetContract(preset)
  const schemaSource = request.schema ?? contract?.schema
  const schema = schemaSource ? cloneStructuredContractValue(schemaSource) : undefined
  const policy = mergePolicy(contract?.policy, request.policy)
  const salvagePolicySource = request.salvagePolicy ?? contract?.salvagePolicy
  const salvagePolicy = salvagePolicySource ? cloneStructuredContractValue(salvagePolicySource) : undefined
  const presetParts = versionPartsFromPreset(preset)
  const presetId = presetParts.presetId
  const presetVersion = presetParts.presetVersion
  const schemaId = contract?.schemaId ?? request.schemaId!.trim()
  const schemaVersion = contract?.schemaVersion ?? request.schemaVersion!.trim()
  const matrixEntry = PROVIDER_PRESET_MATRIX.presets.find(entry =>
    entry.presetId === presetId
    && entry.presetVersion === presetVersion
    && new RegExp(entry.modelPattern, 'iu').test(request.model),
  )
  const provenance = resolveProviderMatrixProvenance(request, contract, matrixEntry)
  const maxTokens = effectiveControl('maxTokens', request.maxTokens, matrixEntry?.maxTokens, contract?.maxTokens)
  const temperature = effectiveControl('temperature', request.temperature, matrixEntry?.temperature)
  const idleTimeoutMs = effectiveControl('idleTimeoutMs', request.idleTimeoutMs, matrixEntry?.idleTimeoutMs)
  const hardTimeoutMs = effectiveControl('hardTimeoutMs', request.hardTimeoutMs, matrixEntry?.hardTimeoutMs)
  const forceLocale = effectiveControl('forceLocale', forcedLocale(request), matrixEntry?.forceLocale)

  const effectiveRequest: StructuredOutputRequest = {
    ...request,
    preset,
    presetId,
    presetVersion,
    schemaId,
    schemaVersion,
    ...(schema ? { schema } : {}),
    ...(policy ? { policy } : {}),
    ...(salvagePolicy ? { salvagePolicy } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
    ...(hardTimeoutMs !== undefined ? { hardTimeoutMs } : {}),
    ...(forceLocale !== undefined ? { forceLocale } : {}),
    providerMatrixProvenance: provenance,
  }
  resolvedStructuredOutputContracts.set(effectiveRequest, resolvedStructuredOutputContractHash(effectiveRequest))
  return effectiveRequest
}

function resolvedStructuredOutputContractHash(request: StructuredOutputRequest): string {
  return createHash('sha256').update(stableSortedJson(request)).digest('hex')
}

function effectiveControl<T>(
  _name: StructuredOutputEffectiveControl,
  requestValue: T | undefined,
  matrixValue: T | undefined,
  presetValue?: T,
): T | undefined {
  return requestValue !== undefined ? requestValue : matrixValue !== undefined ? matrixValue : presetValue
}

function resolveProviderMatrixProvenance(
  request: StructuredOutputRequest,
  contract: StructuredOutputPresetContract | undefined,
  entry: ProviderPresetMatrixEntry | undefined,
): ProviderMatrixProvenance {
  const requestValues: Partial<Record<StructuredOutputEffectiveControl, number | string>> = {
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.idleTimeoutMs !== undefined ? { idleTimeoutMs: request.idleTimeoutMs } : {}),
    ...(request.hardTimeoutMs !== undefined ? { hardTimeoutMs: request.hardTimeoutMs } : {}),
    ...(forcedLocale(request) !== undefined ? { forceLocale: forcedLocale(request) } : {}),
  }
  const matrixValues: Partial<Record<StructuredOutputEffectiveControl, number | string>> = entry
    ? {
        maxTokens: entry.maxTokens,
        temperature: entry.temperature,
        idleTimeoutMs: entry.idleTimeoutMs,
        hardTimeoutMs: entry.hardTimeoutMs,
        ...(entry.forceLocale ? { forceLocale: entry.forceLocale } : {}),
      }
    : {}
  const presetValues: Partial<Record<StructuredOutputEffectiveControl, number | string>> = {
    ...(contract?.maxTokens !== undefined ? { maxTokens: contract.maxTokens } : {}),
  }
  const controls: StructuredOutputEffectiveControl[] = ['maxTokens', 'temperature', 'idleTimeoutMs', 'hardTimeoutMs', 'forceLocale']
  const appliedControls: StructuredOutputEffectiveControl[] = []
  const overrides: ProviderMatrixProvenance['overrides'] = {}
  const controlSources: ProviderMatrixProvenance['controlSources'] = {}
  for (const control of controls) {
    if (requestValues[control] !== undefined) {
      controlSources[control] = 'request'
      overrides[control] = {
        source: 'request',
        value: requestValues[control]!,
        ...(matrixValues[control] !== undefined ? { matrixValue: matrixValues[control] } : {}),
        ...(presetValues[control] !== undefined ? { presetValue: presetValues[control] } : {}),
      }
    } else if (matrixValues[control] !== undefined) {
      controlSources[control] = 'provider_matrix'
      appliedControls.push(control)
    } else if (presetValues[control] !== undefined) {
      controlSources[control] = 'preset_default'
    }
  }
  return {
    providerMatrixVersion: PROVIDER_PRESET_MATRIX.version,
    providerMatrixEntryId: entry ? providerPresetMatrixEntryId(entry) : null,
    providerMatrixEntryHash: entry ? providerPresetMatrixEntryHash(entry) : null,
    matched: Boolean(entry),
    applied: appliedControls.length > 0,
    appliedControls,
    overrides,
    controlSources,
    policyVersions: {
      repairPolicy: entry?.repairPolicy ?? null,
      salvagePolicy: entry?.salvagePolicy ?? null,
      outputDiscipline: entry?.outputDiscipline ?? null,
    },
  }
}

export function providerPresetMatrixEntryId(entry: ProviderPresetMatrixEntry): string {
  return `${PROVIDER_PRESET_MATRIX.version}/${entry.presetId}.${entry.presetVersion}/${entry.provider}`
}

export function providerPresetMatrixEntryHash(entry: ProviderPresetMatrixEntry): string {
  return `sha256:${createHash('sha256').update(stableSortedJson(entry)).digest('hex')}`
}

function stableSortedJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function cloneStructuredContractValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => cloneStructuredContractValue(item)) as T
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) out[key] = cloneStructuredContractValue(item)
  return out as T
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortJson((value as Record<string, unknown>)[key])
  }
  return out
}

function mergePolicy(
  base: StructuredOutputPolicy | undefined,
  overlay: StructuredOutputPolicy | undefined,
): StructuredOutputPolicy | undefined {
  if (!base && !overlay) return undefined
  const forbiddenPhrases = uniqueStrings([
    ...(base?.forbiddenPhrases ?? []),
    ...(overlay?.forbiddenPhrases ?? []),
  ])
  return {
    ...(forbiddenPhrases.length > 0 ? { forbiddenPhrases } : {}),
    ...(overlay?.forbiddenPhraseAction ?? base?.forbiddenPhraseAction
      ? { forbiddenPhraseAction: overlay?.forbiddenPhraseAction ?? base?.forbiddenPhraseAction }
      : {}),
    ...(typeof (overlay?.maxArrayItems ?? base?.maxArrayItems) === 'number'
      ? { maxArrayItems: overlay?.maxArrayItems ?? base?.maxArrayItems }
      : {}),
    ...(typeof (overlay?.maxStringLength ?? base?.maxStringLength) === 'number'
      ? { maxStringLength: overlay?.maxStringLength ?? base?.maxStringLength }
      : {}),
  }
}

export function evaluateStructuredOutputCapabilityGate(
  request: StructuredOutputRequest,
  requestedMaxTokens: number,
): StructuredOutputCapabilityGateResult {
  const capabilities = request.modelCapabilities
  if (!capabilities) {
    return {
      ok: true,
      source: 'fallback',
      requestedMaxTokens,
      appliedMaxTokens: requestedMaxTokens,
      errors: [],
      warnings: ['structured output model capabilities not supplied; using prompt+parse fallback path'],
    }
  }

  const errors: string[] = []
  const warnings: string[] = []
  let appliedMaxTokens = requestedMaxTokens

  if (capabilities.jsonMode.status === 'unsupported') {
    errors.push(`model capability jsonMode=unsupported source=${capabilities.jsonMode.source}`)
  } else if (capabilities.jsonMode.status === 'unknown') {
    warnings.push(`model capability jsonMode=unknown source=${capabilities.jsonMode.source}`)
  }

  const maxOutputCapability = capabilities.maxOutputTokens
  const hasHardMaxOutputCap = maxOutputCapability.source === 'declared' || maxOutputCapability.source === 'manual'
  if (hasHardMaxOutputCap && Number.isFinite(maxOutputCapability.tokens) && maxOutputCapability.tokens > 0) {
    appliedMaxTokens = Math.min(appliedMaxTokens, Math.floor(maxOutputCapability.tokens))
    if (appliedMaxTokens < requestedMaxTokens) {
      warnings.push(`requested maxTokens ${requestedMaxTokens} capped to model maxOutputTokens ${appliedMaxTokens}`)
    }
  } else if (hasHardMaxOutputCap) {
    errors.push(`model capability maxOutputTokens invalid source=${capabilities.maxOutputTokens.source}`)
  }

  return {
    ok: errors.length === 0,
    source: capabilities.jsonMode.source,
    requestedMaxTokens,
    appliedMaxTokens,
    errors,
    warnings,
    modelCapabilities: capabilities,
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stableJson(value: unknown): string {
  return JSON.stringify(value)
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function typeName(value: unknown): JsonSchemaType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'boolean') return 'boolean'
  return 'object'
}

function typeMatches(value: unknown, expected: JsonSchemaType): boolean {
  switch (expected) {
    case 'object':
      return isPlainObject(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
  }
}

export function validateJsonSchema(value: unknown, schema: JsonSchema, path = '$'): string[] {
  const errors: string[] = []

  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => stableJson(candidate) === stableJson(value))) {
    errors.push(`${path} must be one of ${schema.enum.map(stableJson).join(', ')}`)
  }

  if ('const' in schema && stableJson(schema.const) !== stableJson(value)) {
    errors.push(`${path} must equal ${stableJson(schema.const)}`)
  }

  const expectedTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  if (expectedTypes.length > 0 && !expectedTypes.some(expected => typeMatches(value, expected))) {
    const expected = expectedTypes.join(' or ')
    const actual = typeName(value)
    errors.push(`${path} must be ${expected}${actual === 'integer' && expectedTypes.includes('number') ? '' : ` (got ${actual})`}`)
    return errors
  }

  if (isPlainObject(value)) {
    const properties = schema.properties ?? {}
    for (const requiredField of schema.required ?? []) {
      if (!(requiredField in value)) {
        errors.push(`${path}.${requiredField} is required`)
      }
    }

    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in value) {
        errors.push(...validateJsonSchema(value[key], childSchema, `${path}.${key}`))
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          errors.push(`${path}.${key} is not allowed`)
        }
      }
    } else if (isPlainObject(schema.additionalProperties)) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          errors.push(...validateJsonSchema(value[key], schema.additionalProperties, `${path}.${key}`))
        }
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      errors.push(...validateJsonSchema(item, schema.items as JsonSchema, `${path}[${index}]`))
    })
  }

  return errors
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function findBalancedJsonObject(text: string): string | null {
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i]
      if (inString) {
        if (escaped) {
          escaped = false
        } else if (ch === '\\') {
          escaped = true
        } else if (ch === '"') {
          inString = false
        }
        continue
      }
      if (ch === '"') {
        inString = true
      } else if (ch === '{') {
        depth += 1
      } else if (ch === '}') {
        depth -= 1
        if (depth === 0) return text.slice(start, i + 1)
      }
    }
  }
  return null
}

function parseOrExtractJsonObject(text: string): Record<string, unknown> | null {
  const direct = parseJsonObject(text.trim())
  if (direct) return direct
  const balanced = findBalancedJsonObject(text)
  return balanced ? parseJsonObject(balanced) : null
}

function sanitizeJsonCandidate(candidate: string): string {
  return candidate
    .replace(/(^|[\[{,:])(\s*)[“”](?=\S)/gu, '$1$2"')
    .replace(/[“”](\s*)(?=[}\],:])/gu, '"$1')
    .replace(/,\s*([}\]])/gu, '$1')
}

function closePartialJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let candidate = text.slice(start).trim()
  if (!candidate) return null

  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let i = 0; i < candidate.length; i += 1) {
    const ch = candidate[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      stack.push('}')
    } else if (ch === '[') {
      stack.push(']')
    } else if ((ch === '}' || ch === ']') && stack[stack.length - 1] === ch) {
      stack.pop()
    }
  }

  if (inString) candidate += '"'
  candidate = candidate.replace(/,\s*$/u, '')
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    candidate += stack[i]
  }
  candidate = candidate.replace(/,\s*([}\]])/gu, '$1')
  return candidate
}

function repairJsonObject(text: string): Record<string, unknown> | null {
  const sanitizedText = sanitizeJsonCandidate(text)
  const balanced = findBalancedJsonObject(sanitizedText)
  if (balanced) {
    const sanitized = sanitizeJsonCandidate(balanced)
    const parsed = parseJsonObject(sanitized)
    if (parsed) return parsed
  }

  const repaired = closePartialJsonObject(sanitizedText)
  return repaired ? parseJsonObject(sanitizeJsonCandidate(repaired)) : null
}

function fieldsFromSchema(schema: JsonSchema | undefined): string[] {
  const ordered = [
    ...(schema?.required ?? []),
    ...Object.keys(schema?.properties ?? {}),
  ]
  return [...new Set(ordered)]
}

function coerceScalar(raw: string): unknown {
  const trimmed = raw.trim().replace(/^["'“”‘’]|["'“”‘’]$/gu, '')
  if (/^-?\d+(?:\.\d+)?$/u.test(trimmed)) return Number(trimmed)
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  return trimmed
}

function salvageBulletList(text: string, escapedField: string): string[] | null {
  const match = text.match(new RegExp(`(?:^|\\n)\\s*${escapedField}\\s*:\\s*\\n((?:\\s*[-*]\\s+[^\\n]+\\n?)+)`, 'u'))
  if (!match?.[1]) return null
  const items = match[1]
    .split('\n')
    .map(line => line.replace(/^\s*[-*]\s+/u, '').trim())
    .filter(Boolean)
  return items.length > 0 ? items : null
}

function salvageInlineArray(text: string, escapedField: string): unknown[] | null {
  const match = text.match(new RegExp(`(?:^|\\n)\\s*${escapedField}\\s*:\\s*\\[([^\\n\\]]*)`, 'u'))
  if (!match?.[1]) return null
  const items = match[1]
    .split(',')
    .map(item => item.trim().replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/gu, ''))
    .filter(Boolean)
    .map(coerceScalar)
  return items.length > 0 ? items : null
}

function salvageFields(text: string, fields: string[]): Record<string, unknown> | null {
  const artifact: Record<string, unknown> = {}
  for (const field of fields) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const quoted = new RegExp(`"${escaped}"\\s*:\\s*("([^"\\\\]|\\\\.)*"|-?\\d+(?:\\.\\d+)?|true|false|null)`, 'u')
    const quotedMatch = text.match(quoted)
    if (quotedMatch?.[1]) {
      artifact[field] = coerceScalar(quotedMatch[1])
      continue
    }

    const inlineArray = salvageInlineArray(text, escaped)
    if (inlineArray) {
      artifact[field] = inlineArray
      continue
    }

    const bulletList = salvageBulletList(text, escaped)
    if (bulletList) {
      artifact[field] = bulletList
      continue
    }

    const line = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*:\\s*([^\\n,}]+)`, 'u')
    const lineMatch = text.match(line)
    if (lineMatch?.[1]) {
      artifact[field] = coerceScalar(lineMatch[1])
    }
  }
  return Object.keys(artifact).length > 0 ? artifact : null
}

function sanitizeForbiddenPhrases(
  artifact: Record<string, unknown>,
  policy: StructuredOutputPolicy | undefined,
): Record<string, unknown> {
  const forbiddenPhrases = policy?.forbiddenPhrases?.filter(Boolean) ?? []
  if (policy?.forbiddenPhraseAction !== 'sanitize_to_risks' || forbiddenPhrases.length === 0) {
    return artifact
  }

  const sanitizedPhrases = new Set<string>()
  const sanitizeNode = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const matched = forbiddenPhrases.filter(phrase => node.includes(phrase))
      if (matched.length === 0) return node
      matched.forEach(phrase => sanitizedPhrases.add(phrase))
      return '[sanitized forbidden phrase]'
    }
    if (Array.isArray(node)) return node.map(sanitizeNode)
    if (isPlainObject(node)) {
      const out: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(node)) {
        out[key] = sanitizeNode(child)
      }
      return out
    }
    return node
  }

  const sanitized = sanitizeNode(artifact)
  if (!isPlainObject(sanitized) || sanitizedPhrases.size === 0) {
    return artifact
  }

  const existingRisks = Array.isArray(sanitized.risks)
    ? sanitized.risks.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  sanitized.risks = uniqueStrings([
    ...existingRisks,
    ...Array.from(sanitizedPhrases).map(phrase => `sanitized forbidden phrase: ${phrase}`),
  ])
  return sanitized
}

function collectPolicyErrors(value: unknown, rawText: string, policy: StructuredOutputPolicy | undefined): string[] {
  const errors: string[] = []
  if (!policy) return errors

  if (policy.forbiddenPhraseAction !== 'sanitize_to_risks') {
    const rendered = `${rawText}\n${JSON.stringify(value)}`
    for (const phrase of policy.forbiddenPhrases ?? []) {
      if (phrase && rendered.includes(phrase)) {
        errors.push(`forbidden_phrase:${phrase}`)
      }
    }
  }

  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string' && typeof policy.maxStringLength === 'number' && node.length > policy.maxStringLength) {
      errors.push(`${path} exceeds maxStringLength ${policy.maxStringLength}`)
    }
    if (Array.isArray(node)) {
      if (typeof policy.maxArrayItems === 'number' && node.length > policy.maxArrayItems) {
        errors.push(`${path} exceeds maxArrayItems ${policy.maxArrayItems}`)
      }
      node.forEach((item, index) => walk(item, `${path}[${index}]`))
      return
    }
    if (isPlainObject(node)) {
      for (const [key, child] of Object.entries(node)) {
        walk(child, `${path}.${key}`)
      }
    }
  }
  walk(value, '$')
  return errors
}

function validateArtifact(
  artifact: Record<string, unknown>,
  schema: JsonSchema | undefined,
  rawText: string,
  policy: StructuredOutputPolicy | undefined,
): { artifact: Record<string, unknown>; schemaValid: boolean; validationErrors: string[]; failureReason?: StructuredOutputFailureReason } {
  const preparedArtifact = sanitizeForbiddenPhrases(artifact, policy)
  const schemaErrors = schema ? validateJsonSchema(preparedArtifact, schema) : []
  const policyErrors = collectPolicyErrors(preparedArtifact, rawText, policy)
  const validationErrors = [...schemaErrors, ...policyErrors]
  const schemaValid = validationErrors.length === 0
  const failureReason = policyErrors.length > 0
    ? 'policy_violation'
    : schemaErrors.length > 0
      ? 'schema_validation_failed'
      : undefined
  return { artifact: preparedArtifact, schemaValid, validationErrors, failureReason }
}

function attempt(args: {
  label: StructuredOutputAttemptLabel
  model: string
  stopReason: string | null
  inputTokens?: number
  outputTokens?: number
  durationMs?: number
  parsed: boolean
  schemaValid: boolean
  error?: string
  failureReason?: StructuredOutputFailureReason
  requestedTemperature?: number
  appliedTemperature?: number
  temperatureSource?: StructuredOutputControlSource
  terminationKind?: StructuredOutputTerminationKind
  lastOutputAt?: string
  idleMs?: number
  partialText?: string
  streamingMode?: 'streaming' | 'non_streaming'
  streamDeltaSource?: 'provider_sse' | 'translated_sse' | 'none'
  runtimeExecution?: RuntimeExecutionResult
}): StructuredOutputAttempt {
  return {
    label: args.label,
    model: args.model,
    durationMs: args.durationMs ?? 0,
    inputTokens: args.inputTokens ?? 0,
    outputTokens: args.outputTokens ?? 0,
    stopReason: args.stopReason,
    parsed: args.parsed,
    schemaValid: args.schemaValid,
    ...(args.error ? { error: args.error } : {}),
    ...(args.failureReason ? { failureReason: args.failureReason } : {}),
    ...(args.requestedTemperature !== undefined ? { requestedTemperature: args.requestedTemperature } : {}),
    ...(args.appliedTemperature !== undefined ? { appliedTemperature: args.appliedTemperature } : {}),
    ...(args.temperatureSource ? { temperatureSource: args.temperatureSource } : {}),
    ...(args.terminationKind ? { terminationKind: args.terminationKind } : {}),
    ...(args.lastOutputAt ? { lastOutputAt: args.lastOutputAt } : {}),
    ...(args.idleMs !== undefined ? { idleMs: args.idleMs } : {}),
    ...(args.partialText ? { partialText: args.partialText } : {}),
    ...(args.streamingMode ? { streamingMode: args.streamingMode } : {}),
    ...(args.streamDeltaSource ? { streamDeltaSource: args.streamDeltaSource } : {}),
    ...(args.runtimeExecution ? { runtimeExecution: args.runtimeExecution } : {}),
  }
}

function providerControlAttemptFields(request: StructuredOutputRequest): Pick<StructuredOutputAttempt, 'requestedTemperature' | 'appliedTemperature' | 'temperatureSource'> {
  if (request.temperature === undefined) return {}
  const source = request.providerMatrixProvenance?.controlSources.temperature
  return {
    ...(source === 'request' ? { requestedTemperature: request.temperature } : {}),
    appliedTemperature: request.temperature,
    ...(source ? { temperatureSource: source } : {}),
  }
}

interface GovernanceTelemetry {
  startedAtMs: number
  lastOutputAtMs?: number
  lastOutputAt?: string
  idleMs?: number
  partialText: string
  partialThinkingText?: string
  terminationKind: StructuredOutputTerminationKind
  runtimeExecution?: RuntimeExecutionResult
}

type GovernedExecutorResult =
  | { kind: 'completed'; response: StructuredOutputModelResponse; telemetry: GovernanceTelemetry }
  | { kind: 'timeout'; reason: 'silent_timeout' | 'hard_timeout'; telemetry: GovernanceTelemetry }
  | { kind: 'aborted'; telemetry: GovernanceTelemetry }
  | { kind: 'error'; error: unknown; telemetry: GovernanceTelemetry }

function clampTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.max(1, Math.floor(value))
}

async function runExecutorWithActivityGovernance(args: {
  request: StructuredOutputRequest
  executorRequest: StructuredOutputExecutorRequest
  executor: StructuredOutputExecutor
}): Promise<GovernedExecutorResult> {
  const idleTimeoutMs = clampTimeoutMs(args.request.idleTimeoutMs)
  const hardTimeoutMs = clampTimeoutMs(args.request.hardTimeoutMs)
  const telemetry: GovernanceTelemetry = {
    startedAtMs: Date.now(),
    partialText: '',
    terminationKind: 'completed',
  }

  let settled = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let hardTimer: ReturnType<typeof setTimeout> | undefined
  let abortGraceTimer: ReturnType<typeof setTimeout> | undefined
  let settle: (result: GovernedExecutorResult) => void = () => {}
  let externalAbortListener: (() => void) | undefined
  const controller = new AbortController()
  let resolveRuntimeExecution: () => void = () => undefined
  const runtimeExecutionAvailable = new Promise<void>(resolve => {
    resolveRuntimeExecution = resolve
  })
  const governed = new Promise<GovernedExecutorResult>(resolve => {
    settle = resolve
  })

  const clearTimers = () => {
    if (idleTimer) clearTimeout(idleTimer)
    if (hardTimer) clearTimeout(hardTimer)
    if (abortGraceTimer) clearTimeout(abortGraceTimer)
    idleTimer = undefined
    hardTimer = undefined
    abortGraceTimer = undefined
    if (externalAbortListener && args.request.signal) {
      args.request.signal.removeEventListener('abort', externalAbortListener)
    }
    externalAbortListener = undefined
  }

  const resolveOnce = (result: GovernedExecutorResult) => {
    if (settled) return
    settled = true
    clearTimers()
    settle(result)
  }

  const resolveAfterRuntimeAbort = (result: GovernedExecutorResult) => {
    if (args.request.executorKind !== 'runtime-driver') {
      resolveOnce(result)
      return
    }
    void Promise.race([
      runtimeExecutionAvailable,
      new Promise<void>(resolve => {
        abortGraceTimer = setTimeout(resolve, 1_500)
        abortGraceTimer.unref()
      }),
    ]).then(() => resolveOnce(result))
  }

  const abortAndResolve = (result: GovernedExecutorResult, reason: unknown) => {
    if (args.request.executorKind !== 'runtime-driver') {
      resolveOnce(result)
      if (!controller.signal.aborted) controller.abort(reason)
      return
    }
    if (!controller.signal.aborted) controller.abort(reason)
    resolveAfterRuntimeAbort(result)
  }

  const refreshIdleTimer = () => {
    if (!idleTimeoutMs) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      const now = Date.now()
      const idleSince = telemetry.lastOutputAtMs ?? telemetry.startedAtMs
      telemetry.idleMs = Math.max(0, now - idleSince)
      telemetry.terminationKind = 'silent_timeout'
      abortAndResolve({ kind: 'timeout', reason: 'silent_timeout', telemetry }, 'silent_timeout')
    }, idleTimeoutMs)
  }

  const onOutputDelta = (delta: StructuredOutputDelta) => {
    const text = typeof delta.text === 'string' ? delta.text : ''
    if (!text) return
    if (delta.type === 'thinking') {
      telemetry.partialThinkingText = `${telemetry.partialThinkingText ?? ''}${text}`
      return
    }
    if (delta.type === 'heartbeat') return
    telemetry.partialText += text
    telemetry.lastOutputAtMs = Date.now()
    telemetry.lastOutputAt = new Date(telemetry.lastOutputAtMs).toISOString()
    refreshIdleTimer()
  }

  externalAbortListener = () => {
    const now = Date.now()
    const idleSince = telemetry.lastOutputAtMs ?? telemetry.startedAtMs
    telemetry.idleMs = Math.max(0, now - idleSince)
    telemetry.terminationKind = 'aborted'
    abortAndResolve({ kind: 'aborted', telemetry }, args.request.signal?.reason ?? 'aborted')
  }
  if (args.request.signal) {
    if (args.request.signal.aborted) externalAbortListener()
    else args.request.signal.addEventListener('abort', externalAbortListener, { once: true })
  }

  refreshIdleTimer()
  if (hardTimeoutMs) {
    hardTimer = setTimeout(() => {
      const now = Date.now()
      const idleSince = telemetry.lastOutputAtMs ?? telemetry.startedAtMs
      telemetry.idleMs = Math.max(0, now - idleSince)
      telemetry.terminationKind = 'hard_timeout'
      abortAndResolve({ kind: 'timeout', reason: 'hard_timeout', telemetry }, 'hard_timeout')
    }, hardTimeoutMs)
    hardTimer.unref()
  }

  const executorPromise: Promise<GovernedExecutorResult> = args.executor({
    ...args.executorRequest,
    onOutputDelta,
    signal: controller.signal,
    onRuntimeExecution: result => {
      telemetry.runtimeExecution = result
      resolveRuntimeExecution()
      args.executorRequest.onRuntimeExecution?.(result)
    },
  })
    .then(response => {
      telemetry.runtimeExecution = response.runtimeExecution ?? telemetry.runtimeExecution
      if (telemetry.runtimeExecution) resolveRuntimeExecution()
      telemetry.terminationKind = response.runtimeExecution?.status === 'cancelled'
        ? 'aborted'
        : response.runtimeExecution?.status === 'failed'
          ? 'provider_error'
          : 'completed'
      telemetry.idleMs = telemetry.lastOutputAtMs ? Math.max(0, Date.now() - telemetry.lastOutputAtMs) : undefined
      return { kind: 'completed' as const, response, telemetry }
    })
    .catch(error => {
      telemetry.terminationKind = 'provider_error'
      const now = Date.now()
      const idleSince = telemetry.lastOutputAtMs ?? telemetry.startedAtMs
      telemetry.idleMs = Math.max(0, now - idleSince)
      return { kind: 'error', error, telemetry }
    })

  try {
    return await Promise.race([governed, executorPromise])
  } finally {
    clearTimers()
  }
}

function versionPartsFromPreset(preset: StructuredOutputPreset): {
  presetId: string
  presetVersion: string
} {
  const contract = getStructuredOutputPresetContract(preset)
  if (contract) return { presetId: contract.presetId, presetVersion: contract.presetVersion }
  const match = String(preset).match(/^(.+)\.(v\d+)$/)
  return {
    presetId: match?.[1] ?? String(preset),
    presetVersion: match?.[2] ?? 'custom',
  }
}

function schemaVersionParts(request: StructuredOutputRequest, preset: StructuredOutputPreset): {
  schemaId: string
  schemaVersion: string
} {
  const contract = getStructuredOutputPresetContract(preset)
  const fallback = versionPartsFromPreset(preset)
  return {
    schemaId: contract?.schemaId ?? request.schemaId?.trim() ?? fallback.presetId,
    schemaVersion: contract?.schemaVersion ?? request.schemaVersion?.trim() ?? fallback.presetVersion,
  }
}

function forcedLocale(request: StructuredOutputRequest): string | undefined {
  const raw = request.forceLocale ?? request.force_locale
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

function localeContractPrompt(locale: string | undefined): string | null {
  if (!locale) return null
  return [
    `Locale contract: all user-facing display text MUST be written in ${locale}.`,
    'Do not translate schema constants, IDs, URLs, file paths, or source references.',
  ].join('\n')
}

function failedFallbackArtifact(args: {
  request: StructuredOutputRequest
  preset: StructuredOutputPreset
  failureReason: StructuredOutputFailureReason
  stopReason: string | null
  inputTokens: number
  outputTokens: number
  repairCount: number
  salvageUsed: boolean
  rawText?: string
  rawThinkingText?: string
  terminationKind?: StructuredOutputTerminationKind
}): Record<string, unknown> {
  return {
    artifact: 'failed_fallback.v1',
    ok: false,
    usable: false,
    unusableReason: args.failureReason,
    failureReason: args.failureReason,
    rawText: args.rawText ?? '',
    ...(args.rawThinkingText ? { rawThinkingText: args.rawThinkingText } : {}),
    terminationKind: args.terminationKind ?? 'unknown',
    model: args.request.model,
    preset: args.preset,
    provider: providerFromModel(args.request.model),
    stopReason: args.stopReason,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    repairCount: args.repairCount,
    repairUsed: args.repairCount > 0,
    salvageUsed: args.salvageUsed,
    fallbackUsed: true,
    retryHint: 'rerun_role_artifact',
    createdAt: new Date().toISOString(),
  }
}

function providerFromModel(model: string): string {
  if (/kimi|moonshot/i.test(model)) return 'kimi'
  if (/deepseek/i.test(model)) return 'deepseek'
  if (/gpt|openai/i.test(model)) return 'openai'
  return 'unknown'
}

function modelResponseAttemptFields(
  modelResponse: StructuredOutputModelResponse,
): Pick<StructuredOutputAttempt, 'streamingMode' | 'streamDeltaSource' | 'runtimeExecution'> {
  return {
    ...(modelResponse.streamingMode ? { streamingMode: modelResponse.streamingMode } : {}),
    ...(modelResponse.streamDeltaSource ? { streamDeltaSource: modelResponse.streamDeltaSource } : {}),
    ...(modelResponse.runtimeExecution ? { runtimeExecution: modelResponse.runtimeExecution } : {}),
  }
}

interface DisplayStringValue {
  path: string
  value: string
}

function displayStringValues(value: unknown, path = ''): DisplayStringValue[] {
  if (typeof value === 'string') {
    if (isNonDisplayStringPath(path)) return []
    if (/^[a-z0-9_.:/#-]+$/i.test(value.trim())) return []
    return [{ path: path || '$', value }]
  }
  if (Array.isArray(value)) return value.flatMap((item, index) => displayStringValues(item, `${path}[${index}]`))
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([key, child]) => displayStringValues(child, path ? `${path}.${key}` : key))
  }
  return []
}

function isNonDisplayStringPath(path: string): boolean {
  const segments = path.split(/[[\].]+/).filter(Boolean)
  return segments.some(segment =>
    /^(artifact|id|ids|url|urls|path|paths|ref|refs|source_ref|source_refs|evidence_ref|evidence_refs|role|preset|model|provider|schema|schema_id|schema_version|preset_id|preset_version)$/i.test(segment),
  )
}

function localeValidationErrors(artifact: Record<string, unknown>, locale: string | undefined): string[] {
  if (!locale) return []
  if (locale.toLowerCase() !== 'zh-cn') return []
  const values = displayStringValues(artifact)
  if (values.length === 0) return []
  const mismatches = values
    .filter(({ value }) => !/[\u3400-\u9fff]/u.test(value))
    .map(({ path }) => `locale_mismatch:${locale}:${path}`)
  return mismatches.length > 0 ? [`locale_mismatch:${locale}`, ...mismatches] : []
}

function buildArtifactCompleteness(args: {
  schema: JsonSchema | undefined
  artifact: Record<string, unknown>
  okCandidate: boolean
  validationErrors: string[]
  repairCount: number
  salvageUsed: boolean
  fallbackUsed: boolean
}): ArtifactCompletenessReceipt {
  const expected = args.schema?.required ?? []
  const produced = args.fallbackUsed
    ? ['failed_fallback.v1']
    : Object.keys(args.artifact).filter(key => args.artifact[key] !== undefined)
  const missing = args.fallbackUsed
    ? expected
    : expected.filter(field => !Object.prototype.hasOwnProperty.call(args.artifact, field))
  const fallbackStatus: ArtifactCompletenessFallbackStatus = args.fallbackUsed
    ? 'failed_fallback'
    : args.salvageUsed
      ? 'salvage'
      : args.repairCount > 0
        ? 'repair'
        : 'none'
  const validationStatus: ArtifactCompletenessValidationStatus = args.okCandidate && missing.length === 0 && args.validationErrors.length === 0
    ? 'pass'
    : args.validationErrors.length > 0 || missing.length > 0 || args.fallbackUsed
      ? 'fail'
      : 'unknown'
  return {
    expected,
    produced,
    missing,
    validationStatus,
    fallbackStatus,
    artifactRefs: [],
  }
}

function buildSalvageReceipt(args: {
  artifact: Record<string, unknown>
  schema: JsonSchema | undefined
  salvageUsed: boolean
  fallbackUsed: boolean
  failureReason?: string
}): StructuredOutputSalvageReceipt {
  const expected = args.schema?.required ?? []
  const missingRequiredFields = expected.filter(field => !Object.prototype.hasOwnProperty.call(args.artifact, field))
  return {
    used: args.salvageUsed,
    fields: args.salvageUsed && !args.fallbackUsed ? { ...args.artifact } : {},
    missingRequiredFields,
    confidence: args.salvageUsed && missingRequiredFields.length === 0 ? 'medium' : args.salvageUsed ? 'low' : 'high',
    ...(args.failureReason ? { reason: args.failureReason } : {}),
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function structuredOutputFailureReason(value: string | undefined): StructuredOutputFailureReason | undefined {
  return STRUCTURED_OUTPUT_FAILURE_REASONS.includes(value as StructuredOutputFailureReason)
    ? value as StructuredOutputFailureReason
    : undefined
}

function buildConsumerReadiness(args: {
  usable: boolean
  fallbackUsed: boolean
  schemaValid: boolean
  missing: string[]
  validationErrors: string[]
  terminationKind: StructuredOutputTerminationKind
  unusableReason?: string
}): ConsumerReadinessGate {
  const blockers: ConsumerReadinessGate['blockers'] = []
  const warnings: ConsumerReadinessGate['warnings'] = []
  if (args.fallbackUsed) blockers.push({ code: 'failed_fallback', message: 'Structured output fell back to failed_fallback artifact' })
  if (!args.schemaValid) blockers.push({ code: 'schema_invalid', message: 'Structured output schema validation failed' })
  if (args.missing.length > 0) {
    blockers.push({
      code: 'missing_required_artifact',
      message: `Missing required artifact fields: ${args.missing.join(', ')}`,
    })
  }
  if (args.terminationKind === 'silent_timeout') blockers.push({ code: 'silent_timeout', message: 'Structured output attempt was idle past timeout' })
  if (args.terminationKind === 'hard_timeout') blockers.push({ code: 'hard_timeout', message: 'Structured output attempt reached hard timeout' })
  if (args.unusableReason === 'locale_mismatch') blockers.push({ code: 'locale_mismatch', message: 'Structured output locale does not match requested forceLocale' })
  if (args.unusableReason === 'output_budget_exhausted') {
    blockers.push({ code: 'output_budget_exhausted', message: 'Structured output exhausted its provider output-token budget before producing a valid artifact' })
  }
  if (args.validationErrors.some(error => error.startsWith('forbidden_phrase'))) {
    blockers.push({ code: 'policy_violation', message: 'Structured output contains forbidden policy phrase' })
  }
  if (!args.usable && blockers.length === 0) {
    blockers.push({ code: args.unusableReason ?? 'unusable', message: 'Structured output is not consumer ready' })
  }
  return {
    consumerReady: args.usable && blockers.length === 0,
    blockers,
    warnings,
    requiredArtifactsMissing: args.missing,
    fallbackUsed: args.fallbackUsed,
    usable: args.usable,
  }
}

function finalizeStructuredOutputResponse(args: {
  request: StructuredOutputRequest
  preset: StructuredOutputPreset
  artifact: Record<string, unknown>
  rawText: string
  rawThinkingText?: string
  parsed: boolean
  schemaValid: boolean
  validationErrors: string[]
  attempts: StructuredOutputAttempt[]
  repairCount: number
  salvageUsed: boolean
  fallbackUsed: boolean
  stopReason: string | null
  inputTokens: number
  outputTokens: number
  durationMs: number
  capabilityGatePayload: { capabilityGate?: StructuredOutputCapabilityGateResult }
  failureReason?: StructuredOutputFailureReason
  terminationKind?: StructuredOutputTerminationKind
  lastOutputAt?: string
  idleMs?: number
}): StructuredOutputResponse {
  const terminationKind = args.terminationKind ?? 'completed'
  const runtimeExecution = args.attempts.find(item => item.runtimeExecution)?.runtimeExecution
  const localeErrors = args.fallbackUsed ? [] : localeValidationErrors(args.artifact, forcedLocale(args.request))
  const validationErrors = uniqueStrings([...args.validationErrors, ...localeErrors])
  const localeMismatch = localeErrors.length > 0
  const schemaValid = args.schemaValid && !localeMismatch
  const completeness = buildArtifactCompleteness({
    schema: args.request.schema,
    artifact: args.artifact,
    okCandidate: !args.fallbackUsed && schemaValid,
    validationErrors,
    repairCount: args.repairCount,
    salvageUsed: args.salvageUsed,
    fallbackUsed: args.fallbackUsed,
  })
  const unusableReason: StructuredOutputFailureReason | undefined = args.failureReason
    ?? (localeMismatch ? 'locale_mismatch' : undefined)
    ?? (args.fallbackUsed ? structuredOutputFailureReason(optionalString(args.artifact['failureReason'])) ?? 'failed_fallback' : undefined)
    ?? (terminationKind === 'silent_timeout' || terminationKind === 'hard_timeout' ? terminationKind : undefined)
    ?? (!schemaValid ? 'schema_validation_failed' : undefined)
    ?? (completeness.missing.length > 0 ? 'missing_required_artifact' : undefined)
  const usable = !args.fallbackUsed
    && schemaValid
    && completeness.missing.length === 0
    && terminationKind !== 'silent_timeout'
    && terminationKind !== 'hard_timeout'
  const consumerReadiness = buildConsumerReadiness({
    usable,
    fallbackUsed: args.fallbackUsed,
    schemaValid,
    missing: completeness.missing,
    validationErrors,
    terminationKind,
    unusableReason,
  })
  const presetParts = versionPartsFromPreset(args.preset)
  const contract = getStructuredOutputPresetContract(args.preset)
  const schemaParts = schemaVersionParts(args.request, args.preset)
  const salvage = buildSalvageReceipt({
    artifact: args.artifact,
    schema: args.request.schema,
    salvageUsed: args.salvageUsed,
    fallbackUsed: args.fallbackUsed,
    failureReason: unusableReason,
  })
  const attempts = args.attempts.map(item => ({
    ...item,
    ...(runtimeExecution && !item.runtimeExecution ? { runtimeExecution } : {}),
    ...(item.label === 'fallback' && unusableReason && !item.failureReason ? { failureReason: unusableReason } : {}),
    providerMatrixProvenance: args.request.providerMatrixProvenance,
    terminationKind: item.terminationKind ?? terminationKind,
    ...(args.lastOutputAt && !item.lastOutputAt ? { lastOutputAt: args.lastOutputAt } : {}),
    ...(args.idleMs !== undefined && item.idleMs === undefined ? { idleMs: args.idleMs } : {}),
    ...(args.rawText && item.partialText === undefined && (terminationKind === 'silent_timeout' || terminationKind === 'hard_timeout')
      ? { partialText: args.rawText }
      : {}),
  }))
  if (args.fallbackUsed) {
    args.artifact['usable'] = false
    args.artifact['unusableReason'] = unusableReason
    args.artifact['rawText'] = args.rawText
    if (args.rawThinkingText) args.artifact['rawThinkingText'] = args.rawThinkingText
    args.artifact['attempts'] = attempts
    args.artifact['terminationKind'] = terminationKind
    args.artifact['repairUsed'] = args.repairCount > 0
    args.artifact['fallbackUsed'] = true
    if (runtimeExecution) args.artifact['runtimeExecution'] = runtimeExecution
  }
  return {
    ok: usable,
    artifact: args.artifact,
    data: args.artifact,
    rawText: args.rawText,
    ...(args.rawThinkingText ? { rawThinkingText: args.rawThinkingText } : {}),
    usable,
    ...(unusableReason && !usable ? { failureReason: unusableReason, unusableReason } : {}),
    salvage,
    artifactCompleteness: completeness,
    consumerReady: consumerReadiness.consumerReady,
    consumerReadiness,
    terminationKind,
    ...(args.lastOutputAt ? { lastOutputAt: args.lastOutputAt } : {}),
    ...(args.idleMs !== undefined ? { idleMs: args.idleMs } : {}),
    presetId: contract?.presetId ?? args.request.presetId?.trim() ?? presetParts.presetId,
    presetVersion: contract?.presetVersion ?? args.request.presetVersion?.trim() ?? presetParts.presetVersion,
    schemaId: schemaParts.schemaId,
    schemaVersion: schemaParts.schemaVersion,
    repairPolicyVersion: 'repair-policy.v1',
    providerMatrixVersion: PROVIDER_PRESET_MATRIX.version,
    providerMatrixProvenance: args.request.providerMatrixProvenance!,
    parsed: args.parsed,
    schemaValid,
    validationErrors,
    attempts,
    repairCount: args.repairCount,
    salvageUsed: args.salvageUsed,
    fallbackUsed: args.fallbackUsed,
    stopReason: args.stopReason,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    durationMs: args.durationMs,
    ...args.capabilityGatePayload,
    ...(runtimeExecution ? { runtimeExecution } : {}),
  }
}

function schemaContractPrompt(schema: JsonSchema | undefined): string | null {
  if (!schema || schema.type !== 'object') return null
  const lines = ['Structured output contract:']
  if (schema.required?.length) {
    lines.push(`Required top-level keys: ${schema.required.join(', ')}`)
  }
  const constFields = Object.entries(schema.properties ?? {})
    .flatMap(([key, value]) => value.const !== undefined ? [`${key}=${JSON.stringify(value.const)}`] : [])
  if (constFields.length > 0) {
    lines.push(`Constant fields: ${constFields.join(', ')}`)
  }
  if (schema.additionalProperties === false) {
    lines.push('Do not add top-level keys outside this schema.')
  }
  return lines.length > 1 ? lines.join('\n') : null
}

function joinSystemPrompt(system: string | undefined, preset: StructuredOutputPreset, schema: JsonSchema | undefined, locale: string | undefined): string {
  const presetSystem = STRUCTURED_OUTPUT_PRESETS[preset as keyof typeof STRUCTURED_OUTPUT_PRESETS]?.system
  return [presetSystem, schemaContractPrompt(schema), localeContractPrompt(locale), system].filter(Boolean).join('\n\n')
}

export async function runModelOutputHarness(
  request: StructuredOutputRequest,
  executor: StructuredOutputExecutor,
  executionLimits: StructuredOutputExecutionLimits = {},
): Promise<StructuredOutputResponse> {
  const start = Date.now()
  const resolvedHash = resolvedStructuredOutputContracts.get(request)
  if (resolvedHash && resolvedStructuredOutputContractHash(request) !== resolvedHash) {
    throw new Error('resolved structured output contract was mutated before execution')
  }
  const effectiveRequest = resolvedHash ? request : resolveStructuredOutputContract(request)
  const preset = effectiveRequest.preset ?? 'evidence-digest.v1'
  const attempts: StructuredOutputAttempt[] = []
  const requestedMaxTokens = effectiveRequest.maxTokens ?? 1024
  const evaluatedCapabilityGate = evaluateStructuredOutputCapabilityGate(effectiveRequest, requestedMaxTokens)
  const maxTokens = executionLimits.maxTokens === undefined
    ? evaluatedCapabilityGate.appliedMaxTokens
    : Math.min(evaluatedCapabilityGate.appliedMaxTokens, Math.max(1, Math.floor(executionLimits.maxTokens)))
  const capabilityGate = maxTokens === evaluatedCapabilityGate.appliedMaxTokens
    ? evaluatedCapabilityGate
    : {
        ...evaluatedCapabilityGate,
        appliedMaxTokens: maxTokens,
        warnings: [...evaluatedCapabilityGate.warnings, 'task execution budget reduced appliedMaxTokens'],
      }
  const capabilityGatePayload = effectiveRequest.modelCapabilities ? { capabilityGate } : {}
  const providerControls = providerControlAttemptFields(effectiveRequest)

  if (!capabilityGate.ok) {
    const durationMs = Date.now() - start
      const failureReason: StructuredOutputFailureReason = capabilityGate.errors.some(error => error.includes('jsonMode=unsupported'))
      ? 'capability_json_unsupported'
      : 'capability_gate_failed'
    const fallbackArtifact = failedFallbackArtifact({
      request: effectiveRequest,
      preset,
      failureReason,
      stopReason: null,
      inputTokens: 0,
      outputTokens: 0,
      repairCount: 0,
      salvageUsed: false,
      rawText: '',
      terminationKind: 'unknown',
    })
    attempts.push(attempt({
      label: 'fallback',
      model: effectiveRequest.model,
      stopReason: null,
      parsed: false,
      schemaValid: false,
      durationMs,
      error: failureReason,
      terminationKind: 'unknown',
      ...providerControls,
    }))
    return finalizeStructuredOutputResponse({
      request: effectiveRequest,
      preset,
      artifact: fallbackArtifact,
      rawText: '',
      parsed: false,
      schemaValid: false,
      validationErrors: capabilityGate.errors,
      attempts,
      repairCount: 0,
      salvageUsed: false,
      fallbackUsed: true,
      stopReason: null,
      inputTokens: 0,
      outputTokens: 0,
      durationMs,
      capabilityGatePayload,
      failureReason,
      terminationKind: 'unknown',
    })
  }

  let modelResponse: StructuredOutputModelResponse
  let telemetry: GovernanceTelemetry | undefined
  try {
    const executionRequest = executionLimits.hardTimeoutMs === undefined
      ? effectiveRequest
      : {
          ...effectiveRequest,
          hardTimeoutMs: Math.min(
            effectiveRequest.hardTimeoutMs ?? executionLimits.hardTimeoutMs,
            Math.max(1, Math.floor(executionLimits.hardTimeoutMs)),
          ),
        }
    const governed = await runExecutorWithActivityGovernance({
      request: executionRequest,
      executor,
      executorRequest: {
        ...executionRequest,
        preset,
        system: joinSystemPrompt(effectiveRequest.system, preset, effectiveRequest.schema, forcedLocale(effectiveRequest)),
        maxTokens,
      },
    })
    telemetry = governed.telemetry
    if (governed.kind === 'aborted') {
      const durationMs = Date.now() - start
      const rawText = governed.telemetry.partialText
      const rawThinkingText = governed.telemetry.partialThinkingText
      const fallbackArtifact = failedFallbackArtifact({
        request: effectiveRequest,
        preset,
        failureReason: 'aborted',
        stopReason: 'aborted',
        inputTokens: 0,
        outputTokens: 0,
        repairCount: 0,
        salvageUsed: false,
        rawText,
        rawThinkingText,
        terminationKind: 'aborted',
      })
      attempts.push(attempt({
        label: 'primary',
        model: effectiveRequest.model,
        stopReason: 'aborted',
        parsed: false,
        schemaValid: false,
        durationMs,
        error: 'aborted',
        terminationKind: 'aborted',
        runtimeExecution: governed.telemetry.runtimeExecution,
        ...providerControls,
      }))
      attempts.push(attempt({
        label: 'fallback',
        model: effectiveRequest.model,
        stopReason: 'aborted',
        parsed: false,
        schemaValid: false,
        error: 'aborted',
        failureReason: 'aborted',
        terminationKind: 'aborted',
        runtimeExecution: governed.telemetry.runtimeExecution,
        ...providerControls,
      }))
      return finalizeStructuredOutputResponse({
        request: effectiveRequest,
        preset,
        artifact: fallbackArtifact,
        rawText,
        ...(rawThinkingText ? { rawThinkingText } : {}),
        parsed: false,
        schemaValid: false,
        validationErrors: ['aborted'],
        attempts,
        repairCount: 0,
        salvageUsed: false,
        fallbackUsed: true,
        stopReason: 'aborted',
        inputTokens: 0,
        outputTokens: 0,
        durationMs,
        capabilityGatePayload,
        failureReason: 'aborted',
        terminationKind: 'aborted',
        lastOutputAt: governed.telemetry.lastOutputAt,
        idleMs: governed.telemetry.idleMs,
      })
    }
    if (governed.kind === 'timeout') {
      const durationMs = Date.now() - start
      const rawText = governed.telemetry.partialText
      const rawThinkingText = governed.telemetry.partialThinkingText
      const fallbackArtifact = failedFallbackArtifact({
        request: effectiveRequest,
        preset,
        failureReason: governed.reason,
        stopReason: governed.reason,
        inputTokens: 0,
        outputTokens: 0,
        repairCount: 0,
        salvageUsed: false,
        rawText,
        rawThinkingText,
        terminationKind: governed.reason,
      })
      attempts.push(attempt({
        label: 'primary',
        model: effectiveRequest.model,
        stopReason: governed.reason,
        parsed: false,
        schemaValid: false,
        durationMs,
        error: governed.reason,
        terminationKind: governed.reason,
        ...(governed.telemetry.lastOutputAt ? { lastOutputAt: governed.telemetry.lastOutputAt } : {}),
        ...(governed.telemetry.idleMs !== undefined ? { idleMs: governed.telemetry.idleMs } : {}),
        ...(rawText ? { partialText: rawText } : {}),
        runtimeExecution: governed.telemetry.runtimeExecution,
        ...providerControls,
      }))
      attempts.push(attempt({
        label: 'fallback',
        model: effectiveRequest.model,
        stopReason: governed.reason,
        parsed: false,
        schemaValid: false,
        error: governed.reason,
        terminationKind: governed.reason,
        ...(governed.telemetry.lastOutputAt ? { lastOutputAt: governed.telemetry.lastOutputAt } : {}),
        ...(governed.telemetry.idleMs !== undefined ? { idleMs: governed.telemetry.idleMs } : {}),
        ...(rawText ? { partialText: rawText } : {}),
        runtimeExecution: governed.telemetry.runtimeExecution,
        ...providerControls,
      }))
      return finalizeStructuredOutputResponse({
        request: effectiveRequest,
        preset,
        artifact: fallbackArtifact,
        rawText,
        ...(rawThinkingText ? { rawThinkingText } : {}),
        parsed: false,
        schemaValid: false,
        validationErrors: [governed.reason],
        attempts,
        repairCount: 0,
        salvageUsed: false,
        fallbackUsed: true,
        stopReason: governed.reason,
        inputTokens: 0,
        outputTokens: 0,
        durationMs,
        capabilityGatePayload,
        failureReason: governed.reason,
        terminationKind: governed.reason,
        lastOutputAt: governed.telemetry.lastOutputAt,
        idleMs: governed.telemetry.idleMs,
      })
    }
    if (governed.kind === 'error') {
      const durationMs = Date.now() - start
      const failureReason = 'model_call_failed'
      const rawText = governed.telemetry.partialText
      const rawThinkingText = governed.telemetry.partialThinkingText
      const errorMessage = governed.error instanceof Error ? governed.error.message : String(governed.error)
      const fallbackArtifact = failedFallbackArtifact({
        request: effectiveRequest,
        preset,
        failureReason,
        stopReason: null,
        inputTokens: 0,
        outputTokens: 0,
        repairCount: 0,
        salvageUsed: false,
        rawText,
        rawThinkingText,
        terminationKind: 'provider_error',
      })
      attempts.push(attempt({
        label: 'primary',
        model: effectiveRequest.model,
        stopReason: null,
        parsed: false,
        schemaValid: false,
        durationMs,
        error: errorMessage,
        terminationKind: 'provider_error',
        ...(governed.telemetry.lastOutputAt ? { lastOutputAt: governed.telemetry.lastOutputAt } : {}),
        ...(governed.telemetry.idleMs !== undefined ? { idleMs: governed.telemetry.idleMs } : {}),
        ...(rawText ? { partialText: rawText } : {}),
        ...providerControls,
      }))
      attempts.push(attempt({
        label: 'fallback',
        model: effectiveRequest.model,
        stopReason: null,
        parsed: false,
        schemaValid: false,
        error: failureReason,
        terminationKind: 'provider_error',
        ...(governed.telemetry.lastOutputAt ? { lastOutputAt: governed.telemetry.lastOutputAt } : {}),
        ...(governed.telemetry.idleMs !== undefined ? { idleMs: governed.telemetry.idleMs } : {}),
        ...(rawText ? { partialText: rawText } : {}),
        ...providerControls,
      }))
      return finalizeStructuredOutputResponse({
        request: effectiveRequest,
        preset,
        artifact: fallbackArtifact,
        rawText,
        ...(rawThinkingText ? { rawThinkingText } : {}),
        parsed: false,
        schemaValid: false,
        validationErrors: [failureReason],
        attempts,
        repairCount: 0,
        salvageUsed: false,
        fallbackUsed: true,
        stopReason: null,
        inputTokens: 0,
        outputTokens: 0,
        durationMs,
        capabilityGatePayload,
        failureReason,
        terminationKind: 'provider_error',
        lastOutputAt: governed.telemetry.lastOutputAt,
        idleMs: governed.telemetry.idleMs,
      })
    }
    modelResponse = governed.response
  } catch (err) {
    const durationMs = Date.now() - start
    const failureReason = 'model_call_failed'
    const rawText = telemetry?.partialText ?? ''
    const rawThinkingText = telemetry?.partialThinkingText
    const fallbackArtifact = failedFallbackArtifact({
      request: effectiveRequest,
      preset,
      failureReason,
      stopReason: null,
      inputTokens: 0,
      outputTokens: 0,
      repairCount: 0,
      salvageUsed: false,
      rawText,
      rawThinkingText,
      terminationKind: 'provider_error',
    })
    attempts.push(attempt({
      label: 'primary',
      model: effectiveRequest.model,
      stopReason: null,
      parsed: false,
      schemaValid: false,
      durationMs,
      error: err instanceof Error ? err.message : String(err),
      terminationKind: 'provider_error',
      ...(telemetry?.lastOutputAt ? { lastOutputAt: telemetry.lastOutputAt } : {}),
      ...(telemetry?.idleMs !== undefined ? { idleMs: telemetry.idleMs } : {}),
      ...(rawText ? { partialText: rawText } : {}),
      ...providerControls,
    }))
    attempts.push(attempt({
      label: 'fallback',
      model: effectiveRequest.model,
      stopReason: null,
      parsed: false,
      schemaValid: false,
      error: failureReason,
      terminationKind: 'provider_error',
      ...(telemetry?.lastOutputAt ? { lastOutputAt: telemetry.lastOutputAt } : {}),
      ...(telemetry?.idleMs !== undefined ? { idleMs: telemetry.idleMs } : {}),
      ...(rawText ? { partialText: rawText } : {}),
      ...providerControls,
    }))
    return finalizeStructuredOutputResponse({
      request: effectiveRequest,
      preset,
      artifact: fallbackArtifact,
      rawText,
      ...(rawThinkingText ? { rawThinkingText } : {}),
      parsed: false,
      schemaValid: false,
      validationErrors: [failureReason],
      attempts,
      repairCount: 0,
      salvageUsed: false,
      fallbackUsed: true,
      stopReason: null,
      inputTokens: 0,
      outputTokens: 0,
      durationMs,
      capabilityGatePayload,
      failureReason,
      terminationKind: 'provider_error',
      lastOutputAt: telemetry?.lastOutputAt,
      idleMs: telemetry?.idleMs,
    })
  }

  const rawText = modelResponse.text ?? ''
  const rawThinkingText = modelResponse.thinkingText
  const stopReason = modelResponse.stopReason ?? null
  const inputTokens = modelResponse.inputTokens ?? 0
  const outputTokens = modelResponse.outputTokens ?? 0
  const primaryDurationMs = modelResponse.durationMs ?? Math.max(0, Date.now() - start)
  const totalDurationMs = primaryDurationMs
  const terminationKind = telemetry?.terminationKind ?? 'completed'
  attempts.push(attempt({
    label: 'primary',
    model: effectiveRequest.model,
    stopReason,
    inputTokens,
    outputTokens,
    durationMs: primaryDurationMs,
    parsed: false,
    schemaValid: false,
    ...(rawText.trim() ? {} : { error: rawThinkingText ? 'empty_text_with_thinking' : 'empty_text' }),
    terminationKind,
    ...(telemetry?.lastOutputAt ? { lastOutputAt: telemetry.lastOutputAt } : {}),
    ...(telemetry?.idleMs !== undefined ? { idleMs: telemetry.idleMs } : {}),
    ...modelResponseAttemptFields(modelResponse),
    ...providerControls,
  }))

  let repairCount = 0
  let salvageUsed = false

  const fallback = (failureReason: StructuredOutputFailureReason, validationErrors: string[] = [failureReason]): StructuredOutputResponse => {
    const resolvedFailureReason: StructuredOutputFailureReason = stopReason === 'max_tokens'
      && ['schema_validation_failed', 'parse_failed', 'empty_text', 'empty_text_with_thinking'].includes(failureReason)
      ? 'output_budget_exhausted'
      : failureReason
    const artifact = failedFallbackArtifact({
      request: effectiveRequest,
      preset,
      failureReason: resolvedFailureReason,
      stopReason,
      inputTokens,
      outputTokens,
      repairCount,
      salvageUsed,
      rawText,
      rawThinkingText,
      terminationKind,
    })
    attempts.push(attempt({
      label: 'fallback',
      model: effectiveRequest.model,
      stopReason,
      parsed: false,
      schemaValid: false,
      error: resolvedFailureReason,
      failureReason: resolvedFailureReason,
      terminationKind,
      ...(telemetry?.lastOutputAt ? { lastOutputAt: telemetry.lastOutputAt } : {}),
      ...(telemetry?.idleMs !== undefined ? { idleMs: telemetry.idleMs } : {}),
      ...providerControls,
    }))
    return finalizeStructuredOutputResponse({
      request: effectiveRequest,
      preset,
      artifact,
      rawText,
      ...(rawThinkingText ? { rawThinkingText } : {}),
      parsed: false,
      schemaValid: false,
      validationErrors,
      attempts,
      repairCount,
      salvageUsed,
      fallbackUsed: true,
      stopReason,
      inputTokens,
      outputTokens,
      durationMs: totalDurationMs,
      capabilityGatePayload,
      failureReason: resolvedFailureReason,
      terminationKind,
      lastOutputAt: telemetry?.lastOutputAt,
      idleMs: telemetry?.idleMs,
    })
  }

  if (modelResponse.runtimeExecution && modelResponse.runtimeExecution.status !== 'completed') {
    return fallback('runtime_execution_failed', [
      modelResponse.runtimeExecution.failure?.code ?? 'runtime_execution_failed',
    ])
  }

  if (!rawText.trim()) {
    if (rawThinkingText?.trim()) {
      const parsedThinking = parseOrExtractJsonObject(rawThinkingText)
      if (parsedThinking) {
        const validation = validateArtifact(parsedThinking, effectiveRequest.schema, rawThinkingText, effectiveRequest.policy)
        attempts.push(attempt({
          label: 'salvage',
          model: effectiveRequest.model,
          stopReason,
          parsed: false,
          schemaValid: validation.schemaValid,
          ...(validation.schemaValid ? {} : { error: validation.validationErrors.join('; ') }),
          ...providerControls,
        }))
        if (validation.schemaValid) {
          salvageUsed = true
          return finalizeStructuredOutputResponse({
            request: effectiveRequest,
            preset,
            artifact: validation.artifact,
            rawText,
            rawThinkingText,
            parsed: false,
            schemaValid: true,
            validationErrors: [],
            attempts,
            repairCount,
            salvageUsed,
            fallbackUsed: false,
            stopReason,
            inputTokens,
            outputTokens,
            durationMs: totalDurationMs,
            capabilityGatePayload,
            terminationKind,
            lastOutputAt: telemetry?.lastOutputAt,
            idleMs: telemetry?.idleMs,
          })
        }
      }
    }
    return fallback(rawThinkingText ? 'empty_text_with_thinking' : 'empty_text')
  }

  const repairEnabled = effectiveRequest.repairPolicy?.enabled !== false
  const repairAttempts = effectiveRequest.repairPolicy?.maxAttempts ?? 1
  const parsed = parseOrExtractJsonObject(rawText)
  if (parsed) {
    const validation = validateArtifact(parsed, effectiveRequest.schema, rawText, effectiveRequest.policy)
    attempts.push(attempt({
      label: 'parse',
      model: effectiveRequest.model,
      stopReason,
      parsed: true,
      schemaValid: validation.schemaValid,
      ...(validation.schemaValid ? {} : { error: validation.validationErrors.join('; ') }),
    }))
    if (validation.schemaValid) {
      return finalizeStructuredOutputResponse({
        request: effectiveRequest,
        preset,
        artifact: validation.artifact,
        rawText,
        ...(rawThinkingText ? { rawThinkingText } : {}),
        parsed: true,
        schemaValid: true,
        validationErrors: [],
        attempts,
        repairCount,
        salvageUsed,
        fallbackUsed: false,
        stopReason,
        inputTokens,
        outputTokens,
        durationMs: totalDurationMs,
        capabilityGatePayload,
        terminationKind,
        lastOutputAt: telemetry?.lastOutputAt,
        idleMs: telemetry?.idleMs,
      })
    }
    if (repairEnabled && repairAttempts > 0) {
      const repaired = repairJsonObject(rawText)
      if (repaired && stableJson(repaired) !== stableJson(parsed)) {
        repairCount = 1
        const repairedValidation = validateArtifact(repaired, effectiveRequest.schema, rawText, effectiveRequest.policy)
        attempts.push(attempt({
          label: 'repair',
          model: effectiveRequest.model,
          stopReason,
          parsed: true,
          schemaValid: repairedValidation.schemaValid,
          ...(repairedValidation.schemaValid ? {} : { error: repairedValidation.validationErrors.join('; ') }),
        }))
        if (repairedValidation.schemaValid) {
          return finalizeStructuredOutputResponse({
            request: effectiveRequest,
            preset,
            artifact: repairedValidation.artifact,
            rawText,
            ...(rawThinkingText ? { rawThinkingText } : {}),
            parsed: true,
            schemaValid: true,
            validationErrors: [],
            attempts,
            repairCount,
            salvageUsed,
            fallbackUsed: false,
            stopReason,
            inputTokens,
            outputTokens,
            durationMs: totalDurationMs,
            capabilityGatePayload,
            terminationKind,
            lastOutputAt: telemetry?.lastOutputAt,
            idleMs: telemetry?.idleMs,
          })
        }
        return fallback(repairedValidation.failureReason ?? 'schema_validation_failed', repairedValidation.validationErrors)
      }
    }
    return fallback(validation.failureReason ?? 'schema_validation_failed', validation.validationErrors)
  }

  if (repairEnabled && repairAttempts > 0) {
    const repaired = repairJsonObject(rawText)
    if (repaired) {
      repairCount = 1
      const validation = validateArtifact(repaired, effectiveRequest.schema, rawText, effectiveRequest.policy)
      attempts.push(attempt({
        label: 'repair',
        model: effectiveRequest.model,
        stopReason,
        parsed: true,
        schemaValid: validation.schemaValid,
        ...(validation.schemaValid ? {} : { error: validation.validationErrors.join('; ') }),
      }))
      if (validation.schemaValid) {
        return finalizeStructuredOutputResponse({
          request: effectiveRequest,
          preset,
          artifact: validation.artifact,
          rawText,
          ...(rawThinkingText ? { rawThinkingText } : {}),
          parsed: true,
          schemaValid: true,
          validationErrors: [],
          attempts,
          repairCount,
          salvageUsed,
          fallbackUsed: false,
          stopReason,
          inputTokens,
          outputTokens,
          durationMs: totalDurationMs,
          capabilityGatePayload,
          terminationKind,
          lastOutputAt: telemetry?.lastOutputAt,
          idleMs: telemetry?.idleMs,
        })
      }
      return fallback(validation.failureReason ?? 'schema_validation_failed', validation.validationErrors)
    }
  }

  const salvageEnabled = effectiveRequest.salvagePolicy?.enabled !== false
  if (salvageEnabled) {
    const fields = effectiveRequest.salvagePolicy?.fields?.length
      ? effectiveRequest.salvagePolicy.fields
      : fieldsFromSchema(effectiveRequest.schema)
    const salvaged = salvageFields(rawText, fields)
    if (salvaged) {
      salvageUsed = true
      const validation = validateArtifact(salvaged, effectiveRequest.schema, rawText, effectiveRequest.policy)
      attempts.push(attempt({
        label: 'salvage',
        model: effectiveRequest.model,
        stopReason,
        parsed: false,
        schemaValid: validation.schemaValid,
        ...(validation.schemaValid ? {} : { error: validation.validationErrors.join('; ') }),
      }))
      if (validation.schemaValid) {
        return finalizeStructuredOutputResponse({
          request: effectiveRequest,
          preset,
          artifact: validation.artifact,
          rawText,
          ...(rawThinkingText ? { rawThinkingText } : {}),
          parsed: false,
          schemaValid: true,
          validationErrors: [],
          attempts,
          repairCount,
          salvageUsed,
          fallbackUsed: false,
          stopReason,
          inputTokens,
          outputTokens,
          durationMs: totalDurationMs,
          capabilityGatePayload,
          terminationKind,
          lastOutputAt: telemetry?.lastOutputAt,
          idleMs: telemetry?.idleMs,
        })
      }
      return fallback(validation.failureReason ?? 'schema_validation_failed', validation.validationErrors)
    }
  }

  return fallback('parse_failed')
}
