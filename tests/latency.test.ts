import { describe, it, expect, beforeEach } from 'vitest'
import { recordLatency, getLatencyStats, getAllLatencyStats, resetLatency, formatLatencyStats } from '../src/latency.js'

describe('latency histogram', () => {
  beforeEach(() => {
    resetLatency()
  })

  it('returns null for unknown model', () => {
    expect(getLatencyStats('unknown')).toBeNull()
  })

  it('records and retrieves single sample', () => {
    recordLatency('model-a', 100)
    const stats = getLatencyStats('model-a')
    expect(stats).not.toBeNull()
    expect(stats!.count).toBe(1)
    expect(stats!.min).toBe(100)
    expect(stats!.max).toBe(100)
    expect(stats!.p50).toBe(100)
  })

  it('computes percentiles for multiple samples', () => {
    for (let i = 1; i <= 100; i++) {
      recordLatency('model-b', i * 10)
    }
    const stats = getLatencyStats('model-b')!
    expect(stats.count).toBe(100)
    expect(stats.min).toBe(10)
    expect(stats.max).toBe(1000)
    expect(stats.p50).toBeGreaterThanOrEqual(490)
    expect(stats.p50).toBeLessThanOrEqual(510)
    expect(stats.p90).toBeGreaterThanOrEqual(890)
    expect(stats.p99).toBeGreaterThanOrEqual(980)
  })

  it('ring buffer caps at 200 samples', () => {
    for (let i = 0; i < 300; i++) {
      recordLatency('model-c', i)
    }
    const stats = getLatencyStats('model-c')!
    expect(stats.count).toBe(200)
    expect(stats.min).toBe(100) // first 100 were evicted
  })

  it('getAllLatencyStats returns all models', () => {
    recordLatency('a', 10)
    recordLatency('b', 20)
    const all = getAllLatencyStats()
    expect(Object.keys(all)).toHaveLength(2)
    expect(all['a'].count).toBe(1)
    expect(all['b'].count).toBe(1)
  })

  it('formatLatencyStats produces readable output', () => {
    recordLatency('test', 50)
    recordLatency('test', 100)
    recordLatency('test', 200)
    const output = formatLatencyStats(getAllLatencyStats())
    expect(output).toContain('test')
    expect(output).toContain('p50=')
    expect(output).toContain('p90=')
  })

  it('formatLatencyStats handles empty data', () => {
    const output = formatLatencyStats({})
    expect(output).toContain('No latency data')
  })

  it('resetLatency clears all data', () => {
    recordLatency('x', 42)
    resetLatency()
    expect(getLatencyStats('x')).toBeNull()
  })
})
