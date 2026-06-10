import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverSource = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf-8')

describe('Deep healthz probe', () => {
  it('defines deepHealthProbe function', () => {
    expect(serverSource).toContain('deepHealthProbe')
  })

  it('probes router /v1/models', () => {
    expect(serverSource).toContain('/v1/models')
    expect(serverSource).toContain('config.routerUrl')
  })

  it('reports router reachability', () => {
    expect(serverSource).toContain('reachable')
  })

  it('reports latency', () => {
    expect(serverSource).toContain('latencyMs')
  })

  it('reports model count', () => {
    expect(serverSource).toContain('modelCount')
  })

  it('uses cached probe with TTL', () => {
    expect(serverSource).toContain('healthProbeCache')
    expect(serverSource).toContain('HEALTH_PROBE_TTL')
  })

  it('reports healthy/degraded/unhealthy status', () => {
    expect(serverSource).toContain("'healthy'")
    expect(serverSource).toContain("'degraded'")
    expect(serverSource).toContain("'unhealthy'")
  })

  it('includes circuit breaker state in response', () => {
    expect(serverSource).toContain('circuitBreakers')
  })

  it('includes error budgets in response', () => {
    expect(serverSource).toContain('errorBudgets')
  })

  it('has 5s timeout for probe', () => {
    expect(serverSource).toContain('5000')
  })
})
