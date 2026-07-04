/**
 * GET /v1/perf — Per-model performance metrics endpoint.
 */

import { IncomingMessage, ServerResponse } from 'node:http'
import { getAllModelMetrics, getModelPerfSummary } from '../perf-tracker.js'
import { getAuditSummary } from '../audit-log.js'

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
        usable_output_rate: s.usableOutputRate,
        zero_output_count: s.zeroOutputCount,
        thin_output_count: s.thinOutputCount,
        slow_output_count: s.slowOutputCount,
        total_input_tokens: s.totalInputTokens,
        total_output_tokens: s.totalOutputTokens,
        first_request_at: m.firstRequestAt,
        last_request_at: m.lastRequestAt,
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b?.request_count ?? 0) - (a?.request_count ?? 0))

  const audit = getAuditSummary()
  const hasOutputQualityDegradation = summaries.some(s =>
    (s?.zero_output_count ?? 0) > 0 ||
    (s?.thin_output_count ?? 0) > 0 ||
    (s?.slow_output_count ?? 0) > 0
  )
  const warnings = [
    ...(audit.authFailureCount > 0 ? ['gateway_auth_failures_present'] : []),
    ...(audit.errorCount > 0 && audit.authFailureCount === 0 ? ['gateway_errors_present'] : []),
    ...(hasOutputQualityDegradation ? ['model_output_quality_degraded'] : []),
  ]

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    data: summaries,
    gateway: {
      total_entries: audit.totalEntries,
      error_count: audit.errorCount,
      auth_failure_count: audit.authFailureCount,
      gateway_success_rate: audit.gatewaySuccessRate,
      status_counts: audit.statusCounts,
      avg_duration_ms: audit.avgDurationMs,
    },
    warnings,
  }))
}
