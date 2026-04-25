/**
 * `owlcoda benchmark` — Quick latency/throughput test for configured models.
 * Sends a small prompt to each model via the proxy and measures:
 * - Time to first token (TTFT)
 * - Total response time
 * - Tokens per second (TPS)
 */

export interface BenchmarkResult {
  modelId: string
  success: boolean
  ttftMs?: number
  totalMs?: number
  outputTokens?: number
  tps?: number
  error?: string
}

export interface BenchmarkReport {
  proxyUrl: string
  results: BenchmarkResult[]
  timestamp: string
}

const BENCHMARK_PROMPT = 'Count from 1 to 10, one number per line.'

export async function benchmarkModel(proxyUrl: string, modelId: string): Promise<BenchmarkResult> {
  const body = {
    model: modelId,
    max_tokens: 128,
    stream: true,
    messages: [{ role: 'user', content: BENCHMARK_PROMPT }],
  }

  const startTime = performance.now()
  let ttftMs: number | undefined
  let outputTokens = 0

  try {
    const resp = await fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'benchmark' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })

    if (!resp.ok) {
      const text = await resp.text()
      return { modelId, success: false, error: `HTTP ${resp.status}: ${text.slice(0, 100)}` }
    }

    if (!resp.body) {
      return { modelId, success: false, error: 'No response body' }
    }

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // Detect first content_block_delta for TTFT
      if (ttftMs === undefined && buffer.includes('content_block_delta')) {
        ttftMs = performance.now() - startTime
      }

      // Count delta events for rough token estimation
      const deltaMatches = buffer.match(/content_block_delta/g)
      if (deltaMatches) {
        outputTokens = deltaMatches.length
      }
    }

    const totalMs = performance.now() - startTime
    const tps = totalMs > 0 && outputTokens > 0 ? (outputTokens / (totalMs / 1000)) : undefined

    return {
      modelId,
      success: true,
      ttftMs: ttftMs ? Math.round(ttftMs) : undefined,
      totalMs: Math.round(totalMs),
      outputTokens,
      tps: tps ? Math.round(tps * 10) / 10 : undefined,
    }
  } catch (err) {
    const totalMs = Math.round(performance.now() - startTime)
    const msg = err instanceof Error ? err.message : String(err)
    return { modelId, success: false, totalMs, error: msg }
  }
}

export async function runBenchmark(proxyUrl: string, modelIds: string[]): Promise<BenchmarkReport> {
  const results: BenchmarkResult[] = []

  for (const modelId of modelIds) {
    const result = await benchmarkModel(proxyUrl, modelId)
    results.push(result)
  }

  return {
    proxyUrl,
    results,
    timestamp: new Date().toISOString(),
  }
}

export function formatBenchmarkReport(report: BenchmarkReport): string {
  const lines: string[] = []
  lines.push('⚡ OwlCoda Model Benchmark')
  lines.push('─'.repeat(60))
  lines.push(`  Proxy: ${report.proxyUrl}`)
  lines.push(`  Time: ${report.timestamp}`)
  lines.push('')

  // Header
  lines.push('  Model                        TTFT    Total   TPS     Status')
  lines.push('  ' + '─'.repeat(56))

  for (const r of report.results) {
    const name = r.modelId.length > 28 ? r.modelId.slice(0, 25) + '...' : r.modelId.padEnd(28)
    if (r.success) {
      const ttft = r.ttftMs !== undefined ? `${r.ttftMs}ms`.padEnd(7) : '—'.padEnd(7)
      const total = r.totalMs !== undefined ? `${r.totalMs}ms`.padEnd(7) : '—'.padEnd(7)
      const tps = r.tps !== undefined ? `${r.tps}`.padEnd(7) : '—'.padEnd(7)
      lines.push(`  ${name} ${ttft} ${total} ${tps} ✅`)
    } else {
      const err = (r.error ?? 'unknown error').slice(0, 30)
      lines.push(`  ${name} ${'—'.padEnd(7)} ${'—'.padEnd(7)} ${'—'.padEnd(7)} ❌ ${err}`)
    }
  }

  const successful = report.results.filter(r => r.success)
  lines.push('')
  lines.push(`  ${successful.length}/${report.results.length} models responded successfully`)

  if (successful.length > 0) {
    const avgTtft = successful.filter(r => r.ttftMs).reduce((s, r) => s + r.ttftMs!, 0) / successful.filter(r => r.ttftMs).length
    if (!isNaN(avgTtft)) {
      lines.push(`  Avg TTFT: ${Math.round(avgTtft)}ms`)
    }
  }

  return lines.join('\n')
}
