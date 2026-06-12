// Thin client for the OwlCoda proxy. The entire integration surface of this
// demo is the Anthropic-compatible HTTP API owlcoda exposes — that is the
// point of the demo: `baseURL` is all you need.

export interface OwlcodaModel {
  id: string
  display_name?: string
  label?: string
  tier?: string
  [k: string]: unknown
}

export async function listModels(baseUrl: string): Promise<OwlcodaModel[]> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/models`, {
    headers: { 'x-api-key': 'local' },
  })
  if (!res.ok) throw new Error(`owlcoda /v1/models ${res.status}`)
  const body = (await res.json()) as { data?: OwlcodaModel[]; models?: OwlcodaModel[] }
  return body.data ?? body.models ?? []
}

export async function health(baseUrl: string): Promise<{ ok: boolean; detail?: unknown }> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/health`)
    if (!res.ok) return { ok: false, detail: `status ${res.status}` }
    return { ok: true, detail: await res.json().catch(() => undefined) }
  } catch (err) {
    return { ok: false, detail: String(err) }
  }
}

export interface StreamMessageOptions {
  baseUrl: string
  model: string
  system: string
  user: string
  images?: Array<{ mediaType: string; base64: string }>
  maxTokens?: number
  onDelta?: (text: string) => void
  signal?: AbortSignal
}

export interface StreamMessageResult {
  text: string
  // reasoning models stream thinking_delta before (or instead of) text
  thinking: string
  stopReason?: string
  inputTokens?: number
  outputTokens?: number
  durationMs: number
}

export async function streamMessage(opts: StreamMessageOptions): Promise<StreamMessageResult> {
  const started = Date.now()
  // Some upstreams (kimi) hard-reject empty user content; never let an
  // empty segment leave the building.
  const userText = opts.user.trim() || '(无文本输入,请基于系统提示与附带内容作答)'
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: userText }]
  for (const img of opts.images ?? []) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
    })
  }
  const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'local',
      'anthropic-version': '2023-06-01',
    },
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model,
      // generous default: reasoning models (kimi-k2.6, mimo) spend a large
      // share of the budget on thinking before any text comes out
      max_tokens: opts.maxTokens ?? 16384,
      stream: true,
      system: opts.system,
      messages: [{ role: 'user', content }],
    }),
  })
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`owlcoda /v1/messages ${res.status}: ${detail.slice(0, 300)}`)
  }

  let text = ''
  let thinking = ''
  let stopReason: string | undefined
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let event: any
      try {
        event = JSON.parse(payload)
      } catch {
        continue
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        text += event.delta.text
        opts.onDelta?.(event.delta.text)
      } else if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
        thinking += event.delta.thinking ?? ''
        // surface thinking as progress so the UI isn't silent for minutes
        opts.onDelta?.(event.delta.thinking ?? '')
      } else if (event.type === 'message_start' && event.message?.usage) {
        inputTokens = event.message.usage.input_tokens
      } else if (event.type === 'message_delta') {
        if (event.usage) outputTokens = event.usage.output_tokens
        if (event.delta?.stop_reason) stopReason = event.delta.stop_reason
      }
    }
  }
  return { text, thinking, stopReason, inputTokens, outputTokens, durationMs: Date.now() - started }
}
