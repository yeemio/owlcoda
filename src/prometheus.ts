/**
 * Prometheus / OpenMetrics text format exporter.
 * Reads from observability, circuit-breaker, error-budget modules
 * and renders standard text/plain metrics output.
 */

import { getMetrics } from './observability.js'
import { getAllCircuitStates, type CircuitState } from './middleware/circuit-breaker.js'
import { getAllBudgets } from './error-budget.js'

const CIRCUIT_VALUE: Record<CircuitState, number> = { closed: 0, open: 1, 'half-open': 2 }

function line(name: string, labels: Record<string, string>, value: number): string {
  const labelStr = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')
  return labelStr ? `${name}{${labelStr}} ${value}` : `${name} ${value}`
}

export function renderMetrics(): string {
  const m = getMetrics()
  const lines: string[] = []

  // Uptime
  lines.push('# HELP owlcoda_uptime_seconds Time since proxy started')
  lines.push('# TYPE owlcoda_uptime_seconds gauge')
  lines.push(line('owlcoda_uptime_seconds', {}, Math.round(m.uptime)))

  // Total requests
  lines.push('# HELP owlcoda_requests_total Total requests handled')
  lines.push('# TYPE owlcoda_requests_total counter')
  lines.push(line('owlcoda_requests_total', {}, m.totalRequests))

  // Active requests
  lines.push('# HELP owlcoda_active_requests Currently in-flight requests')
  lines.push('# TYPE owlcoda_active_requests gauge')
  lines.push(line('owlcoda_active_requests', {}, m.activeRequests))

  // Requests by model
  lines.push('# HELP owlcoda_requests_by_model_total Requests per model')
  lines.push('# TYPE owlcoda_requests_by_model_total counter')
  for (const [model, count] of Object.entries(m.requestsByModel)) {
    lines.push(line('owlcoda_requests_by_model_total', { model }, count))
  }

  // Requests by status
  lines.push('# HELP owlcoda_requests_by_status_total Requests per HTTP status')
  lines.push('# TYPE owlcoda_requests_by_status_total counter')
  for (const [status, count] of Object.entries(m.requestsByStatus)) {
    lines.push(line('owlcoda_requests_by_status_total', { status }, count))
  }

  // Average duration by model
  lines.push('# HELP owlcoda_request_duration_avg_ms Average request duration per model in milliseconds')
  lines.push('# TYPE owlcoda_request_duration_avg_ms gauge')
  for (const [model, avg] of Object.entries(m.avgDurationByModel)) {
    lines.push(line('owlcoda_request_duration_avg_ms', { model }, avg))
  }

  // Token usage
  lines.push('# HELP owlcoda_tokens_total Total tokens processed')
  lines.push('# TYPE owlcoda_tokens_total counter')
  lines.push(line('owlcoda_tokens_total', { direction: 'input' }, m.tokenUsage.inputTokens))
  lines.push(line('owlcoda_tokens_total', { direction: 'output' }, m.tokenUsage.outputTokens))

  // Rate limits
  lines.push('# HELP owlcoda_rate_limit_remaining Remaining requests in rate-limit window')
  lines.push('# TYPE owlcoda_rate_limit_remaining gauge')
  for (const [model, rl] of Object.entries(m.rateLimits)) {
    lines.push(line('owlcoda_rate_limit_remaining', { model }, rl.remaining))
  }

  // Circuit breaker states
  const circuits = getAllCircuitStates()
  lines.push('# HELP owlcoda_circuit_breaker_state Circuit breaker state (0=closed, 1=open, 2=half-open)')
  lines.push('# TYPE owlcoda_circuit_breaker_state gauge')
  for (const [model, cs] of Object.entries(circuits)) {
    lines.push(line('owlcoda_circuit_breaker_state', { model }, CIRCUIT_VALUE[cs.state] ?? 0))
  }

  // Error budget success rate
  const budgets = getAllBudgets()
  lines.push('# HELP owlcoda_error_budget_success_rate Per-model success rate (0.0-1.0)')
  lines.push('# TYPE owlcoda_error_budget_success_rate gauge')
  for (const [model, b] of budgets) {
    lines.push(line('owlcoda_error_budget_success_rate', { model }, Number(b.successRate.toFixed(4))))
  }

  // Recent errors
  lines.push('# HELP owlcoda_recent_errors_total Errors in recent window')
  lines.push('# TYPE owlcoda_recent_errors_total gauge')
  lines.push(line('owlcoda_recent_errors_total', {}, m.recentErrors))

  lines.push('')
  return lines.join('\n')
}
