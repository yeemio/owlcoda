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
  system: string
  schema: JsonSchema
  policy: StructuredOutputPolicy
  salvagePolicy: StructuredOutputSalvagePolicy
  maxTokens?: number
}

export interface StructuredOutputRequest {
  model: string
  preset?: StructuredOutputPreset
  schema?: JsonSchema
  system?: string
  user: string
  maxTokens?: number
  repairPolicy?: StructuredOutputRepairPolicy
  salvagePolicy?: StructuredOutputSalvagePolicy
  policy?: StructuredOutputPolicy
  persist?: boolean
  runRef?: string
  role?: string
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
}

export interface StructuredOutputExecutorRequest extends StructuredOutputRequest {
  preset: StructuredOutputPreset
  system: string
  maxTokens: number
}

export interface StructuredOutputModelResponse {
  text: string
  thinkingText?: string
  stopReason?: string | null
  inputTokens?: number
  outputTokens?: number
  durationMs?: number
}

export type StructuredOutputExecutor = (
  request: StructuredOutputExecutorRequest,
) => Promise<StructuredOutputModelResponse>

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
}

export interface StructuredOutputResponse {
  ok: boolean
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
}

export const STRUCTURED_OUTPUT_PRESETS: Record<BuiltinStructuredOutputPreset, StructuredOutputPresetContract> = {
  'evidence-digest.v1': {
    artifact: 'evidence-digest.v1',
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

export function getStructuredOutputPresetContract(
  preset: StructuredOutputPreset | undefined,
): StructuredOutputPresetContract | undefined {
  const resolvedPreset = preset ?? 'evidence-digest.v1'
  return STRUCTURED_OUTPUT_PRESETS[resolvedPreset as BuiltinStructuredOutputPreset]
}

export function structuredOutputRequestContractErrors(request: StructuredOutputRequest): string[] {
  const preset = request.preset ?? 'evidence-digest.v1'
  const contract = getStructuredOutputPresetContract(preset)
  if (!contract && !request.schema) {
    return ['custom preset requires an explicit schema']
  }
  return []
}

export function applyStructuredOutputPresetDefaults(request: StructuredOutputRequest): StructuredOutputRequest {
  const errors = structuredOutputRequestContractErrors(request)
  if (errors.length > 0) {
    throw new Error(errors.join('; '))
  }
  const preset = request.preset ?? 'evidence-digest.v1'
  const contract = getStructuredOutputPresetContract(preset)
  const schema = request.schema ?? contract?.schema
  const policy = mergePolicy(contract?.policy, request.policy)
  const salvagePolicy = request.salvagePolicy ?? contract?.salvagePolicy
  const maxTokens = request.maxTokens ?? contract?.maxTokens

  return {
    ...request,
    preset,
    ...(schema ? { schema } : {}),
    ...(policy ? { policy } : {}),
    ...(salvagePolicy ? { salvagePolicy } : {}),
    ...(maxTokens ? { maxTokens } : {}),
  }
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

function evaluateStructuredOutputCapabilityGate(
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

  if (Number.isFinite(capabilities.maxOutputTokens.tokens) && capabilities.maxOutputTokens.tokens > 0) {
    appliedMaxTokens = Math.min(appliedMaxTokens, Math.floor(capabilities.maxOutputTokens.tokens))
    if (appliedMaxTokens < requestedMaxTokens) {
      warnings.push(`requested maxTokens ${requestedMaxTokens} capped to model maxOutputTokens ${appliedMaxTokens}`)
    }
  } else {
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
  return candidate.replace(/,\s*([}\]])/gu, '$1')
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
  const balanced = findBalancedJsonObject(text)
  if (balanced) {
    const sanitized = sanitizeJsonCandidate(balanced)
    const parsed = parseJsonObject(sanitized)
    if (parsed) return parsed
  }

  const repaired = closePartialJsonObject(text)
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
): { artifact: Record<string, unknown>; schemaValid: boolean; validationErrors: string[]; failureReason?: string } {
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
  }
}

function failedFallbackArtifact(args: {
  request: StructuredOutputRequest
  preset: StructuredOutputPreset
  failureReason: string
  stopReason: string | null
  inputTokens: number
  outputTokens: number
  repairCount: number
  salvageUsed: boolean
}): Record<string, unknown> {
  return {
    artifact: 'failed_fallback.v1',
    ok: false,
    failureReason: args.failureReason,
    model: args.request.model,
    preset: args.preset,
    stopReason: args.stopReason,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    repairCount: args.repairCount,
    salvageUsed: args.salvageUsed,
    retryHint: 'rerun_role_artifact',
  }
}

function joinSystemPrompt(system: string | undefined, preset: StructuredOutputPreset): string {
  const presetSystem = STRUCTURED_OUTPUT_PRESETS[preset as keyof typeof STRUCTURED_OUTPUT_PRESETS]?.system
  return [presetSystem, system].filter(Boolean).join('\n\n')
}

export async function runModelOutputHarness(
  request: StructuredOutputRequest,
  executor: StructuredOutputExecutor,
): Promise<StructuredOutputResponse> {
  const start = Date.now()
  const effectiveRequest = applyStructuredOutputPresetDefaults(request)
  const preset = effectiveRequest.preset ?? 'evidence-digest.v1'
  const attempts: StructuredOutputAttempt[] = []
  const requestedMaxTokens = effectiveRequest.maxTokens ?? 1024
  const capabilityGate = evaluateStructuredOutputCapabilityGate(effectiveRequest, requestedMaxTokens)
  const capabilityGatePayload = effectiveRequest.modelCapabilities ? { capabilityGate } : {}
  const maxTokens = capabilityGate.appliedMaxTokens

  if (!capabilityGate.ok) {
    const durationMs = Date.now() - start
    const failureReason = capabilityGate.errors.some(error => error.includes('jsonMode=unsupported'))
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
    })
    attempts.push(attempt({
      label: 'fallback',
      model: effectiveRequest.model,
      stopReason: null,
      parsed: false,
      schemaValid: false,
      durationMs,
      error: failureReason,
    }))
    return {
      ok: false,
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
      ...capabilityGatePayload,
    }
  }

  let modelResponse: StructuredOutputModelResponse
  try {
    modelResponse = await executor({
      ...effectiveRequest,
      preset,
      system: joinSystemPrompt(effectiveRequest.system, preset),
      maxTokens,
    })
  } catch (err) {
    const durationMs = Date.now() - start
    const failureReason = 'model_call_failed'
    const fallbackArtifact = failedFallbackArtifact({
      request: effectiveRequest,
      preset,
      failureReason,
      stopReason: null,
      inputTokens: 0,
      outputTokens: 0,
      repairCount: 0,
      salvageUsed: false,
    })
    attempts.push(attempt({
      label: 'primary',
      model: effectiveRequest.model,
      stopReason: null,
      parsed: false,
      schemaValid: false,
      durationMs,
      error: err instanceof Error ? err.message : String(err),
    }))
    attempts.push(attempt({
      label: 'fallback',
      model: effectiveRequest.model,
      stopReason: null,
      parsed: false,
      schemaValid: false,
      error: failureReason,
    }))
    return {
      ok: false,
      artifact: fallbackArtifact,
      rawText: '',
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
      ...capabilityGatePayload,
    }
  }

  const rawText = modelResponse.text ?? ''
  const rawThinkingText = modelResponse.thinkingText
  const stopReason = modelResponse.stopReason ?? null
  const inputTokens = modelResponse.inputTokens ?? 0
  const outputTokens = modelResponse.outputTokens ?? 0
  const primaryDurationMs = modelResponse.durationMs ?? Math.max(0, Date.now() - start)
  const totalDurationMs = primaryDurationMs
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
  }))

  let repairCount = 0
  let salvageUsed = false

  const fallback = (failureReason: string, validationErrors: string[] = [failureReason]): StructuredOutputResponse => {
    const artifact = failedFallbackArtifact({
      request: effectiveRequest,
      preset,
      failureReason,
      stopReason,
      inputTokens,
      outputTokens,
      repairCount,
      salvageUsed,
    })
    attempts.push(attempt({
      label: 'fallback',
      model: effectiveRequest.model,
      stopReason,
      parsed: false,
      schemaValid: false,
      error: failureReason,
    }))
    return {
      ok: false,
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
      ...capabilityGatePayload,
    }
  }

  if (!rawText.trim()) {
    return fallback(rawThinkingText ? 'empty_text_with_thinking' : 'empty_text')
  }

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
      return {
        ok: true,
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
        ...capabilityGatePayload,
      }
    }
    return fallback(validation.failureReason ?? 'schema_validation_failed', validation.validationErrors)
  }

  const repairEnabled = effectiveRequest.repairPolicy?.enabled !== false
  const repairAttempts = effectiveRequest.repairPolicy?.maxAttempts ?? 1
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
        return {
          ok: true,
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
          ...capabilityGatePayload,
        }
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
        return {
          ok: true,
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
          ...capabilityGatePayload,
        }
      }
      return fallback(validation.failureReason ?? 'schema_validation_failed', validation.validationErrors)
    }
  }

  return fallback('parse_failed')
}
