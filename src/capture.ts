/**
 * Request/response capture for debugging model interactions.
 * Records last N conversations through the proxy for inspection.
 */

export interface CapturedExchange {
  id: string
  timestamp: string
  model: string
  durationMs: number
  request: {
    messageCount: number
    systemPromptLength: number
    toolCount: number
    streaming: boolean
  }
  response: {
    statusCode: number
    stopReason: string | null
    textLength: number
    toolCallCount: number
    inputTokens?: number
    outputTokens?: number
  }
  error?: string
}

const MAX_CAPTURES = 50
const captures: CapturedExchange[] = []

export function recordExchange(exchange: CapturedExchange): void {
  captures.push(exchange)
  if (captures.length > MAX_CAPTURES) {
    captures.shift()
  }
}

export function getCaptures(limit = 20): CapturedExchange[] {
  return captures.slice(-limit)
}

export function clearCaptures(): void {
  captures.length = 0
}

export function getCaptureStats(): {
  totalExchanges: number
  avgDurationMs: number
  errorRate: number
  modelBreakdown: Record<string, number>
} {
  const total = captures.length
  if (total === 0) {
    return { totalExchanges: 0, avgDurationMs: 0, errorRate: 0, modelBreakdown: {} }
  }

  const avgDuration = captures.reduce((s, c) => s + c.durationMs, 0) / total
  const errors = captures.filter(c => c.error || c.response.statusCode >= 400).length
  const modelBreakdown: Record<string, number> = {}
  for (const c of captures) {
    modelBreakdown[c.model] = (modelBreakdown[c.model] ?? 0) + 1
  }

  return {
    totalExchanges: total,
    avgDurationMs: Math.round(avgDuration),
    errorRate: Math.round((errors / total) * 100) / 100,
    modelBreakdown,
  }
}

export function formatCaptures(exchanges: CapturedExchange[]): string {
  if (exchanges.length === 0) {
    return 'No captured exchanges.'
  }

  const lines: string[] = ['🔍 Recent Exchanges', '─'.repeat(70)]

  for (const ex of exchanges) {
    const ts = ex.timestamp.slice(11, 19)
    const dur = `${ex.durationMs}ms`.padEnd(8)
    const model = ex.model.length > 25 ? ex.model.slice(0, 22) + '...' : ex.model.padEnd(25)
    const status = ex.response.statusCode < 400 ? '✅' : '❌'
    const tokens = ex.response.inputTokens !== undefined
      ? `${ex.response.inputTokens}→${ex.response.outputTokens ?? 0}`
      : '—'

    lines.push(`  ${ts} ${model} ${dur} ${tokens.padEnd(12)} ${status} ${ex.error || ex.response.stopReason || ''}`)
  }

  return lines.join('\n')
}
