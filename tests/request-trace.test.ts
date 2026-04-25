import { describe, it, expect, beforeEach } from 'vitest'
import { createTrace, getRecentTraces, resetTraces } from '../src/request-trace.js'

describe('request tracing', () => {
  beforeEach(() => {
    resetTraces()
  })

  it('creates a trace and returns result', () => {
    const trace = createTrace('req-1')
    trace.mark('received')
    trace.mark('validated')
    const result = trace.end()
    expect(result.requestId).toBe('req-1')
    expect(result.phases.length).toBe(2)
    expect(result.totalMs).toBeGreaterThanOrEqual(0)
  })

  it('computes phase durations', () => {
    const trace = createTrace('req-2')
    trace.mark('start')
    trace.mark('end')
    const result = trace.end()
    expect(result.phases[0].name).toBe('start')
    expect(result.phases[1].name).toBe('end')
    expect(result.phases[0].durationMs).toBeGreaterThanOrEqual(0)
  })

  it('stores traces in circular buffer', () => {
    for (let i = 0; i < 5; i++) {
      const t = createTrace(`req-${i}`)
      t.mark('x')
      t.end()
    }
    const traces = getRecentTraces(3)
    expect(traces.length).toBe(3)
    expect(traces[0].requestId).toBe('req-2')
  })

  it('getRecentTraces returns all when count > buffer', () => {
    const t = createTrace('single')
    t.mark('a')
    t.end()
    const traces = getRecentTraces(100)
    expect(traces.length).toBe(1)
  })

  it('resets traces', () => {
    const t = createTrace('r')
    t.mark('x')
    t.end()
    resetTraces()
    expect(getRecentTraces().length).toBe(0)
  })

  it('handles trace with no marks', () => {
    const trace = createTrace('empty')
    const result = trace.end()
    expect(result.phases.length).toBe(0)
    expect(result.totalMs).toBeGreaterThanOrEqual(0)
  })

  it('respects buffer limit of 50', () => {
    for (let i = 0; i < 60; i++) {
      const t = createTrace(`req-${i}`)
      t.mark('p')
      t.end()
    }
    const all = getRecentTraces(100)
    expect(all.length).toBe(50)
    expect(all[0].requestId).toBe('req-10')
  })
})
