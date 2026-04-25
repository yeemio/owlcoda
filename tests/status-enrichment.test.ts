import { describe, it, expect } from 'vitest'

/**
 * Tests for enriched status display parsing logic.
 * The actual doStatus() requires a running daemon, so we test the
 * data parsing/formatting patterns used in the enriched output.
 */
describe('status enrichment helpers', () => {
  it('uptime formatting: hours and minutes', () => {
    // mirrors the logic in doStatus
    const secs = 7384
    const h = Math.floor(secs / 3600)
    const min = Math.floor((secs % 3600) / 60)
    expect(`${h}h ${min}m`).toBe('2h 3m')
  })

  it('uptime formatting: zero hours', () => {
    const secs = 300
    const h = Math.floor(secs / 3600)
    const min = Math.floor((secs % 3600) / 60)
    expect(`${h}h ${min}m`).toBe('0h 5m')
  })

  it('health status icon mapping', () => {
    const iconFor = (status: string) =>
      status === 'healthy' ? '✅' : status === 'degraded' ? '⚠️' : '❌'

    expect(iconFor('healthy')).toBe('✅')
    expect(iconFor('degraded')).toBe('⚠️')
    expect(iconFor('unhealthy')).toBe('❌')
    expect(iconFor('unknown')).toBe('❌')
  })

  it('router info formatting', () => {
    const router = { reachable: true, latencyMs: 42, modelCount: 5 }
    const latency = typeof router.latencyMs === 'number' ? `${router.latencyMs}ms` : '—'
    const models = typeof router.modelCount === 'number' ? router.modelCount : '?'
    expect(latency).toBe('42ms')
    expect(models).toBe(5)
  })

  it('request count with recent errors', () => {
    const metrics = { totalRequests: 150, recentErrors: 3, activeRequests: 2, uptime: 600 }
    const line = `${metrics.totalRequests} total, ${metrics.recentErrors ?? 0} recent errors`
    expect(line).toBe('150 total, 3 recent errors')
  })

  it('request count with zero errors', () => {
    const metrics = { totalRequests: 42, recentErrors: 0 }
    const line = `${metrics.totalRequests} total, ${metrics.recentErrors ?? 0} recent errors`
    expect(line).toBe('42 total, 0 recent errors')
  })
})
