import { describe, it, expect, beforeEach } from 'vitest'
import { recordRequestStart, recordRequestEnd, getMetrics, resetMetrics, getActiveRequests } from '../src/observability.js'

describe('observability', () => {
  beforeEach(() => {
    resetMetrics()
  })

  it('tracks active requests', () => {
    expect(getActiveRequests()).toBe(0)
    recordRequestStart()
    recordRequestStart()
    expect(getActiveRequests()).toBe(2)
    recordRequestEnd('/v1/messages', 200, 100)
    expect(getActiveRequests()).toBe(1)
  })

  it('records total requests by model and status', () => {
    recordRequestStart()
    recordRequestEnd('/v1/messages', 200, 50)
    recordRequestStart()
    recordRequestEnd('/v1/messages', 200, 150)
    recordRequestStart()
    recordRequestEnd('/v1/models', 200, 10)

    const metrics = getMetrics()
    expect(metrics.totalRequests).toBe(3)
    expect(metrics.requestsByModel['/v1/messages']).toBe(2)
    expect(metrics.requestsByModel['/v1/models']).toBe(1)
    expect(metrics.requestsByStatus['200']).toBe(3)
  })

  it('computes average duration per model', () => {
    recordRequestStart()
    recordRequestEnd('model-a', 200, 100)
    recordRequestStart()
    recordRequestEnd('model-a', 200, 200)

    const metrics = getMetrics()
    expect(metrics.avgDurationByModel['model-a']).toBe(150)
  })

  it('getMetrics returns complete shape', () => {
    const metrics = getMetrics()
    expect(metrics).toHaveProperty('version')
    expect(metrics).toHaveProperty('uptime')
    expect(metrics).toHaveProperty('totalRequests')
    expect(metrics).toHaveProperty('activeRequests')
    expect(metrics).toHaveProperty('requestsByModel')
    expect(metrics).toHaveProperty('requestsByStatus')
    expect(metrics).toHaveProperty('tokenUsage')
    expect(metrics).toHaveProperty('rateLimits')
    expect(metrics).toHaveProperty('recentErrors')
  })

  it('reset clears all counters', () => {
    recordRequestStart()
    recordRequestEnd('x', 200, 10)
    resetMetrics()
    const metrics = getMetrics()
    expect(metrics.totalRequests).toBe(0)
    expect(metrics.activeRequests).toBe(0)
  })
})
