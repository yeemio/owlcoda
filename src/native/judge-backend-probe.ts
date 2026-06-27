export type JudgeProbeCallStatus =
  | 'json_ok'
  | 'empty_response'
  | 'malformed_json'
  | 'timeout'
  | 'http_error'
  | 'fetch_error'

export type JudgeProbeModelStatus = 'healthy' | 'unhealthy'

export interface JudgeBackendProbeInput {
  endpoint: string
  models: string[]
  prompts?: string[]
  timeoutMs?: number
  minJsonSuccessRate?: number
  apiKey?: string
  headers?: Record<string, string>
  maxTokens?: number
}

export interface JudgeProbeCallResult {
  model: string
  promptIndex: number
  status: JudgeProbeCallStatus
  latencyMs: number
  detail: string
  responseLength?: number
}

export interface JudgeProbeModelSummary {
  model: string
  total: number
  jsonOk: number
  emptyResponse: number
  malformedJson: number
  timeout: number
  httpError: number
  fetchError: number
  jsonSuccessRate: number
  averageLatencyMs: number
  status: JudgeProbeModelStatus
  calls: JudgeProbeCallResult[]
}

export interface JudgeBackendProbeResult {
  endpoint: string
  prompts: string[]
  models: Record<string, JudgeProbeModelSummary>
  recommendedModel: string | null
}

export interface JudgeBackendProbeDeps {
  fetch: typeof fetch
  now: () => number
  signal: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 45_000
const DEFAULT_MAX_TOKENS = 256
const DEFAULT_MIN_JSON_SUCCESS_RATE = 1

const DEFAULT_JUDGE_PROMPTS = [
  'Judge whether this output satisfies the instruction. Return JSON only: {"score":1,"reason":"ok"}. Output: concise correct answer.',
  'Judge repetition and instruction following. Return JSON only: {"score":0,"reason":"..."}. Output: repeated repeated repeated repeated.',
  'Judge safety of a structured assistant answer. Return JSON only with score and reason. Output: {"answer":"done","evidence":["path"]}.',
]

export async function runJudgeBackendProbe(
  input: JudgeBackendProbeInput,
  deps: Partial<JudgeBackendProbeDeps> = {},
): Promise<JudgeBackendProbeResult> {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const now = deps.now ?? Date.now
  const endpoint = normalizeEndpoint(input.endpoint)
  const models = normalizeModels(input.models)
  const prompts = normalizePrompts(input.prompts)
  const summaries: Record<string, JudgeProbeModelSummary> = {}
  const minJsonSuccessRate = boundedRate(input.minJsonSuccessRate)

  for (const model of models) {
    const calls: JudgeProbeCallResult[] = []
    for (let i = 0; i < prompts.length; i += 1) {
      throwIfAborted(deps.signal)
      calls.push(await probeOne(fetchImpl, now, {
        endpoint,
        model,
        prompt: prompts[i]!,
        promptIndex: i,
        timeoutMs: resolveTimeoutMs(input.timeoutMs),
        apiKey: input.apiKey,
        headers: input.headers,
        maxTokens: resolveMaxTokens(input.maxTokens),
        signal: deps.signal,
      }))
      throwIfAborted(deps.signal)
    }
    summaries[model] = summarizeModel(model, calls, minJsonSuccessRate)
  }

  const recommendedModel = models.find((model) => summaries[model]?.status === 'healthy') ?? null
  return {
    endpoint,
    prompts,
    models: summaries,
    recommendedModel,
  }
}

export function formatJudgeBackendProbeResult(result: JudgeBackendProbeResult): string {
  const lines = [
    `JudgeBackendProbe endpoint=${result.endpoint}`,
    `recommended_model=${result.recommendedModel ?? 'none'}`,
  ]
  for (const summary of Object.values(result.models)) {
    lines.push(
      `${summary.model}: status=${summary.status} json_ok=${summary.jsonOk}/${summary.total} ` +
      `empty=${summary.emptyResponse} malformed=${summary.malformedJson} timeout=${summary.timeout} ` +
      `http_error=${summary.httpError} fetch_error=${summary.fetchError} avg_latency_ms=${summary.averageLatencyMs}`,
    )
  }
  return lines.join('\n')
}

async function probeOne(
  fetchImpl: typeof fetch,
  now: () => number,
  input: {
    endpoint: string
    model: string
    prompt: string
    promptIndex: number
    timeoutMs: number
    apiKey?: string
    headers?: Record<string, string>
    maxTokens: number
    signal?: AbortSignal
  },
): Promise<JudgeProbeCallResult> {
  const started = now()
  try {
    const headers = new Headers(input.headers ?? {})
    headers.set('content-type', 'application/json')
    if (input.apiKey) headers.set('authorization', `Bearer ${input.apiKey}`)
    const response = await fetchImpl(input.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: input.model,
        stream: false,
        temperature: 0,
        max_tokens: input.maxTokens,
        messages: [
          {
            role: 'system',
            content: 'You are a strict judge backend health probe. Return one valid JSON object only.',
          },
          { role: 'user', content: input.prompt },
        ],
      }),
      signal: composeAbortSignal(input.timeoutMs, input.signal),
    })
    const latencyMs = Math.max(0, now() - started)
    const body = await response.text()
    if (!response.ok) {
      return callResult(input, 'http_error', latencyMs, `HTTP ${response.status}`, body.length)
    }
    const content = extractChatContent(body)
    if (!content.trim()) {
      return callResult(input, 'empty_response', latencyMs, 'empty judge response', body.length)
    }
    if (!parseJudgeJson(content)) {
      return callResult(input, 'malformed_json', latencyMs, 'response did not contain a valid JSON object', content.length)
    }
    return callResult(input, 'json_ok', latencyMs, 'valid JSON judge response', content.length)
  } catch (err) {
    const latencyMs = Math.max(0, now() - started)
    const message = err instanceof Error ? err.message : String(err)
    const status: JudgeProbeCallStatus = isTimeoutError(err) ? 'timeout' : 'fetch_error'
    return callResult(input, status, latencyMs, message)
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  const err = new Error(typeof signal.reason === 'string' ? signal.reason : 'probe aborted')
  err.name = 'AbortError'
  throw err
}

function summarizeModel(
  model: string,
  calls: JudgeProbeCallResult[],
  minJsonSuccessRate: number,
): JudgeProbeModelSummary {
  const total = calls.length
  const count = (status: JudgeProbeCallStatus) => calls.filter((call) => call.status === status).length
  const jsonOk = count('json_ok')
  const emptyResponse = count('empty_response')
  const malformedJson = count('malformed_json')
  const timeout = count('timeout')
  const httpError = count('http_error')
  const fetchError = count('fetch_error')
  const jsonSuccessRate = total > 0 ? jsonOk / total : 0
  const averageLatencyMs = total > 0
    ? Math.round(calls.reduce((sum, call) => sum + call.latencyMs, 0) / total)
    : 0
  const status: JudgeProbeModelStatus =
    total > 0
    && jsonSuccessRate >= minJsonSuccessRate
    && emptyResponse === 0
    && malformedJson === 0
    && timeout === 0
    && httpError === 0
    && fetchError === 0
      ? 'healthy'
      : 'unhealthy'

  return {
    model,
    total,
    jsonOk,
    emptyResponse,
    malformedJson,
    timeout,
    httpError,
    fetchError,
    jsonSuccessRate,
    averageLatencyMs,
    status,
    calls,
  }
}

function callResult(
  input: { model: string; promptIndex: number },
  status: JudgeProbeCallStatus,
  latencyMs: number,
  detail: string,
  responseLength?: number,
): JudgeProbeCallResult {
  return {
    model: input.model,
    promptIndex: input.promptIndex,
    status,
    latencyMs,
    detail,
    ...(responseLength !== undefined ? { responseLength } : {}),
  }
}

function extractChatContent(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as unknown
    const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
    const choices = Array.isArray(record['choices']) ? record['choices'] : []
    const first = choices[0]
    const firstRecord = first && typeof first === 'object' ? first as Record<string, unknown> : {}
    const message = firstRecord['message']
    const messageRecord = message && typeof message === 'object' ? message as Record<string, unknown> : {}
    const content = messageRecord['content'] ?? firstRecord['text']
    return typeof content === 'string' ? content : ''
  } catch {
    return rawBody
  }
}

function parseJudgeJson(content: string): unknown | null {
  const trimmed = content.trim()
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  for (const candidate of [unfenced, extractFirstJsonObject(unfenced)]) {
    if (!candidate) continue
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // try the next candidate
    }
  }
  return null
}

function extractFirstJsonObject(value: string): string | null {
  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return value.slice(start, end + 1)
}

function timeoutSignal(timeoutMs: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined
}

function composeAbortSignal(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal | undefined {
  const timeout = timeoutSignal(timeoutMs)
  const signals = [timeout, signal].filter((item): item is AbortSignal => Boolean(item))
  if (signals.length === 0) return undefined
  if (signals.length === 1) return signals[0]
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function'
    ? AbortSignal.any(signals)
    : signals[0]
}

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.name === 'AbortError'
    || err.name === 'TimeoutError'
    || /aborted|timeout|timed out/i.test(err.message)
}

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim()
  if (!trimmed) return trimmed
  if (/\/chat\/completions\/?$/i.test(trimmed)) return trimmed
  return `${trimmed.replace(/\/+$/, '')}/v1/chat/completions`
}

function normalizeModels(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))]
}

function normalizePrompts(prompts: string[] | undefined): string[] {
  const normalized = (prompts ?? DEFAULT_JUDGE_PROMPTS)
    .map((prompt) => prompt.trim())
    .filter(Boolean)
  return normalized.length > 0 ? normalized.slice(0, 9) : DEFAULT_JUDGE_PROMPTS
}

function resolveTimeoutMs(timeoutMs: number | undefined): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : DEFAULT_TIMEOUT_MS
}

function resolveMaxTokens(maxTokens: number | undefined): number {
  return typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0
    ? Math.floor(maxTokens)
    : DEFAULT_MAX_TOKENS
}

function boundedRate(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MIN_JSON_SUCCESS_RATE
  return Math.max(0, Math.min(1, value))
}
