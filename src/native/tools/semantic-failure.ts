import type { ToolResult } from './types.js'

export type KnownToolFailureCategory =
  | 'remote:auth_or_permission'
  | 'remote:blocked_source'
  | 'remote:rate_limit'
  | 'remote:api_error'
  | 'tool:fs_policy_denied'
  | 'tool:intent_guard_blocked'
  | 'tool:task_guard_blocked'
  | 'tool:command_not_found'
  | 'tool:timeout'
  | 'tool:aborted'

export type ToolFailureCategory = KnownToolFailureCategory | (string & {})

export interface ToolFailurePolicy {
  category: ToolFailureCategory
  reason: string
  terminal: boolean
  retryable: boolean
  evidence: string
  source: 'remote-output' | 'tool-metadata'
}

const REMOTE_QUERY_TOOLS = new Set(['bash', 'PowerShell', 'WebFetch', 'MCPTool', 'ReadMcpResource'])

const AUTH_OR_PERMISSION_RE =
  /(?:无效的?客户端\s*key|客户端\s*key\s*无效|无效的?\s*(?:api\s*)?key|invalid[_ -]?(?:api[_ -]?)?key|unauthori[sz]ed|authentication(?: failed| error)?|auth(?:entication)?\s*(?:failed|error)|forbidden|permission denied|access denied|invalid[_ -]?token|expired[_ -]?token|missing[_ -]?(?:api[_ -]?)?key|未授权|未认证|认证失败|鉴权失败|没有权限|无权限|权限不足|令牌无效|token\s*无效|登录过期)/i

const RATE_LIMIT_RE =
  /(?:rate[_ -]?limit|too many requests|quota exceeded|insufficient quota|限流|频率限制|请求过多|额度不足|超出配额)/i

const REMOTE_ERROR_FIELD_RE = /"(?:error|detail|message|msg|code|error_code|errorCode)"\s*:/
const FAILURE_STATUS_FIELD_RE = /"(?:success|ok)"\s*:\s*false/i
const NO_DATA_RE = /\b(?:not found|no data|empty|不存在|无数据|没有数据|查无)\b/i

export function classifyToolFailurePolicy(
  toolName: string,
  input: Record<string, unknown>,
  result: ToolResult,
): ToolFailurePolicy | null {
  const metadataPolicy = classifyToolMetadataFailure(result)
  if (isRecoverableToolFailure(toolName, result)) return metadataPolicy
  const remotePolicy = classifyRemoteToolOutputFailure(toolName, input, result)
  if (remotePolicy) return remotePolicy
  return metadataPolicy
}

export function classifySemanticToolFailure(
  toolName: string,
  input: Record<string, unknown>,
  result: ToolResult,
): ToolFailurePolicy | null {
  return classifyRemoteToolOutputFailure(toolName, input, result)
}

export function applyToolFailurePolicy(
  toolName: string,
  input: Record<string, unknown>,
  result: ToolResult,
): ToolResult {
  const policy = classifyToolFailurePolicy(toolName, input, result)
  if (!policy) return result

  const metadata = {
    ...(result.metadata ?? {}),
    failurePolicyApplied: true,
    failureCategory: policy.category,
    failureRetryable: policy.retryable,
    failureTerminal: policy.terminal,
    failureSource: policy.source,
    failureEvidence: policy.evidence,
    semanticFailure: policy.source === 'remote-output',
    semanticFailureEvidence: policy.source === 'remote-output' ? policy.evidence : undefined,
  } as Record<string, unknown>

  let output = result.output
  if (policy.terminal) {
    const prefix = [
      '[Runtime failure-policy guard]',
      policy.reason,
      'This is a terminal data-source/tooling failure, not an empty result. Fix credentials/configuration or ask the user before continuing.',
      '',
    ].join('\n')
    output = `${prefix}${result.output}`
    metadata['terminalToolFailure'] = true
    metadata['terminalFailureReason'] = policy.reason
  }

  return {
    ...result,
    output,
    isError: result.isError || policy.terminal,
    metadata: compactMetadata(metadata),
  }
}

export const applySemanticToolFailure = applyToolFailurePolicy

function classifyRemoteToolOutputFailure(
  toolName: string,
  input: Record<string, unknown>,
  result: ToolResult,
): ToolFailurePolicy | null {
  if (!REMOTE_QUERY_TOOLS.has(toolName)) return null

  const output = result.output
  if (!output || output.trim().length === 0) return null

  if (toolName === 'bash' && !isLikelyRemoteBashCommand(input)) return null
  if (toolName === 'PowerShell' && !isLikelyRemotePowerShellCommand(input)) return null

  const payload = extractSemanticPayload(toolName, output)
  const compact = payload.replace(/\s+/g, ' ').trim()
  if (!compact) return null

  const parsed = parseJsonishPayload(compact)
  if (parsed) {
    return classifyFatalRemoteErrorObject(parsed)
  }

  const searchable = compact.slice(0, 4000)
  const machineErrorText = looksLikeShortRemoteErrorText(compact)

  if (machineErrorText && AUTH_OR_PERMISSION_RE.test(searchable)) {
    return {
      category: 'remote:auth_or_permission',
      reason: `Remote query returned an authentication/permission failure (${firstEvidence(searchable)}).`,
      terminal: true,
      retryable: false,
      evidence: firstEvidence(searchable),
      source: 'remote-output',
    }
  }

  if (machineErrorText && RATE_LIMIT_RE.test(searchable)) {
    return {
      category: 'remote:rate_limit',
      reason: `Remote query returned a rate-limit/quota failure (${firstEvidence(searchable)}).`,
      terminal: true,
      retryable: true,
      evidence: firstEvidence(searchable),
      source: 'remote-output',
    }
  }

  return null
}

function classifyToolMetadataFailure(result: ToolResult): ToolFailurePolicy | null {
  if (!result.isError) return null

  const metadata = result.metadata ?? {}
  const evidence = firstEvidence(result.output || JSON.stringify(metadata))

  if (metadata['fsPolicyDenied'] === true) {
    return {
      category: 'tool:fs_policy_denied',
      reason: `Tool write path was denied by filesystem policy (${evidence}).`,
      terminal: false,
      retryable: false,
      evidence,
      source: 'tool-metadata',
    }
  }

  if (metadata['intentGuardBlocked'] === true) {
    return {
      category: 'tool:intent_guard_blocked',
      reason: `Tool call was blocked by the current task intent (${evidence}).`,
      terminal: false,
      retryable: false,
      evidence,
      source: 'tool-metadata',
    }
  }

  if (metadata['taskGuardBlocked'] === true) {
    return {
      category: 'tool:task_guard_blocked',
      reason: `Tool call was blocked by the task contract (${evidence}).`,
      terminal: false,
      retryable: false,
      evidence,
      source: 'tool-metadata',
    }
  }

  if (metadata['commandNotFound'] === true) {
    const missing = typeof metadata['missingCommand'] === 'string'
      ? metadata['missingCommand']
      : evidence
    return {
      category: 'tool:command_not_found',
      reason: `Local command was not found (${missing}).`,
      terminal: false,
      retryable: false,
      evidence: missing,
      source: 'tool-metadata',
    }
  }

  if (metadata['failureCategory'] === 'remote:blocked_source' || metadata['blockedSource'] === true) {
    return {
      category: 'remote:blocked_source',
      reason: `Remote source blocked direct fetch; preserve the URL as blocked evidence or use an alternate capture route (${evidence}).`,
      terminal: false,
      retryable: false,
      evidence,
      source: 'tool-metadata',
    }
  }

  if (metadata['aborted'] === true) {
    return {
      category: 'tool:aborted',
      reason: `Tool execution was aborted (${evidence}).`,
      terminal: false,
      retryable: true,
      evidence,
      source: 'tool-metadata',
    }
  }

  if (/\b(?:timed out|timeout)\b|超时/i.test(result.output)) {
    return {
      category: 'tool:timeout',
      reason: `Tool execution timed out (${evidence}).`,
      terminal: false,
      retryable: true,
      evidence,
      source: 'tool-metadata',
    }
  }

  return null
}

function isRecoverableToolFailure(toolName: string, result: ToolResult): boolean {
  const metadata = result.metadata ?? {}
  return toolName === 'WebFetch'
    && metadata['recoverable'] === true
    && (metadata['failureCategory'] === 'remote:blocked_source' || metadata['failureCategory'] === 'web-fetch:http-403')
}

function classifyFatalRemoteErrorObject(value: unknown): ToolFailurePolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const serialized = JSON.stringify(value)
  if (!REMOTE_ERROR_FIELD_RE.test(serialized) && !FAILURE_STATUS_FIELD_RE.test(serialized)) return null
  if (NO_DATA_RE.test(serialized)) return null
  if (AUTH_OR_PERMISSION_RE.test(serialized)) {
    return {
      category: 'remote:auth_or_permission',
      reason: `Remote query returned an authentication/permission failure (${firstEvidence(serialized)}).`,
      terminal: true,
      retryable: false,
      evidence: firstEvidence(serialized),
      source: 'remote-output',
    }
  }
  if (RATE_LIMIT_RE.test(serialized)) {
    return {
      category: 'remote:rate_limit',
      reason: `Remote query returned a rate-limit/quota failure (${firstEvidence(serialized)}).`,
      terminal: true,
      retryable: true,
      evidence: firstEvidence(serialized),
      source: 'remote-output',
    }
  }

  const status = getObjectValue(value, ['status', 'statusCode', 'code', 'error_code', 'errorCode'])
  const numericStatus = typeof status === 'number'
    ? status
    : typeof status === 'string' && /^\d+$/.test(status)
      ? Number.parseInt(status, 10)
      : null
  if (numericStatus === 401 || numericStatus === 403) {
    return {
      category: 'remote:auth_or_permission',
      reason: `Remote query returned an authentication/permission failure (${firstEvidence(serialized)}).`,
      terminal: true,
      retryable: false,
      evidence: firstEvidence(serialized),
      source: 'remote-output',
    }
  }
  if (numericStatus === 429) {
    return {
      category: 'remote:rate_limit',
      reason: `Remote query returned a rate-limit/quota failure (${firstEvidence(serialized)}).`,
      terminal: true,
      retryable: true,
      evidence: firstEvidence(serialized),
      source: 'remote-output',
    }
  }
  if (numericStatus !== null && numericStatus >= 500) {
    return {
      category: 'remote:api_error',
      reason: `Remote query returned an API error object (${firstEvidence(serialized)}).`,
      terminal: true,
      retryable: true,
      evidence: firstEvidence(serialized),
      source: 'remote-output',
    }
  }

  return null
}

function isLikelyRemoteBashCommand(input: Record<string, unknown>): boolean {
  const command = String(input['command'] ?? '')
  return /\b(?:curl|wget|http|httpie|fetch|axios)\b/i.test(command)
}

function isLikelyRemotePowerShellCommand(input: Record<string, unknown>): boolean {
  const command = String(input['command'] ?? '')
  return /\b(?:Invoke-RestMethod|Invoke-WebRequest|curl|wget)\b/i.test(command)
}

function extractSemanticPayload(toolName: string, output: string): string {
  if (toolName === 'bash') {
    const stdoutMatch = output.match(/\[stdout\]\n([\s\S]*?)(?:\n\[stderr\]|\n\[killed\]|\n\[exit code:|\s*$)/)
    if (stdoutMatch?.[1]) return stdoutMatch[1].trim()
  }

  if (toolName === 'WebFetch') {
    const separator = output.indexOf('\n\n')
    if (separator >= 0) return output.slice(separator + 2).trim()
  }

  return output.trim()
}

function parseJsonishPayload(text: string): unknown | null {
  const trimmed = text.trim()
  const candidates = [trimmed]

  const firstObject = trimmed.indexOf('{')
  const lastObject = trimmed.lastIndexOf('}')
  if (firstObject >= 0 && lastObject > firstObject) {
    candidates.push(trimmed.slice(firstObject, lastObject + 1))
  }

  const firstArray = trimmed.indexOf('[')
  const lastArray = trimmed.lastIndexOf(']')
  if (firstArray >= 0 && lastArray > firstArray) {
    candidates.push(trimmed.slice(firstArray, lastArray + 1))
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // try next candidate
    }
  }
  return null
}

function looksLikeShortRemoteErrorText(text: string): boolean {
  if (text.length > 1500) return false
  if (/^\s*(?:HTTP\/\d(?:\.\d)?\s+)?(?:401|403|429|5\d\d)\b/i.test(text)) return true
  if (/^\s*(?:error|detail|message|msg)\s*[:：]/i.test(text)) return true
  if (/^\s*[\[{]/.test(text) && (REMOTE_ERROR_FIELD_RE.test(text) || FAILURE_STATUS_FIELD_RE.test(text))) return true
  return (AUTH_OR_PERMISSION_RE.test(text) || RATE_LIMIT_RE.test(text)) && text.split(/[。.!?\n]/).filter(Boolean).length <= 4
}

function getObjectValue(value: unknown, keys: string[]): unknown {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of keys) {
    if (record[key] !== undefined) return record[key]
  }
  return undefined
}

function firstEvidence(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact
}

function compactMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  )
}
