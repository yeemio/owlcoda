/**
 * GET /v1/perf — Per-model performance metrics endpoint.
 */

import { IncomingMessage, ServerResponse } from 'node:http'
import { getAllModelMetrics, getModelPerfSummary } from '../perf-tracker.js'

export function handlePerf(_req: IncomingMessage, res: ServerResponse): void {
  const metrics = getAllModelMetrics()

  const summaries = metrics
    .map(m => {
      const s = getModelPerfSummary(m.modelId)
      if (!s) return null
      return {
        model_id: s.modelId,
        request_count: s.requestCount,
        avg_duration_ms: s.avgDurationMs,
        p50_duration_ms: s.p50DurationMs,
        avg_output_tps: s.avgOutputTps,
        success_rate: s.successRate,
        total_input_tokens: s.totalInputTokens,
        total_output_tokens: s.totalOutputTokens,
        first_request_at: m.firstRequestAt,
        last_request_at: m.lastRequestAt,
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b?.request_count ?? 0) - (a?.request_count ?? 0))

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ data: summaries }))
}
