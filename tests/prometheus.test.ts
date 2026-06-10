import { describe, it, expect } from 'vitest'
import { renderMetrics } from '../src/prometheus.js'

describe('Prometheus metrics', () => {
  const output = renderMetrics()
  const lines = output.split('\n')

  it('renders non-empty output', () => {
    expect(output.length).toBeGreaterThan(0)
  })

  it('includes owlcoda_uptime_seconds', () => {
    expect(output).toContain('owlcoda_uptime_seconds')
  })

  it('includes owlcoda_requests_total', () => {
    expect(output).toContain('owlcoda_requests_total')
  })

  it('includes owlcoda_active_requests', () => {
    expect(output).toContain('owlcoda_active_requests')
  })

  it('includes owlcoda_tokens_total with direction labels', () => {
    expect(output).toContain('owlcoda_tokens_total{direction="input"}')
    expect(output).toContain('owlcoda_tokens_total{direction="output"}')
  })

  it('includes owlcoda_recent_errors_total', () => {
    expect(output).toContain('owlcoda_recent_errors_total')
  })

  it('has HELP annotations for each metric', () => {
    const helpLines = lines.filter(l => l.startsWith('# HELP'))
    expect(helpLines.length).toBeGreaterThanOrEqual(9)
  })

  it('has TYPE annotations for each metric', () => {
    const typeLines = lines.filter(l => l.startsWith('# TYPE'))
    expect(typeLines.length).toBeGreaterThanOrEqual(9)
  })

  it('uses correct TYPE values', () => {
    expect(output).toContain('# TYPE owlcoda_uptime_seconds gauge')
    expect(output).toContain('# TYPE owlcoda_requests_total counter')
    expect(output).toContain('# TYPE owlcoda_active_requests gauge')
    expect(output).toContain('# TYPE owlcoda_tokens_total counter')
  })

  it('includes circuit breaker state metric', () => {
    expect(output).toContain('owlcoda_circuit_breaker_state')
  })

  it('includes error budget success rate metric', () => {
    expect(output).toContain('owlcoda_error_budget_success_rate')
  })
})
