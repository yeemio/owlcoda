import { describe, it, expect, afterEach } from 'vitest'
import { getModelHealth, getAllModelHealth, isModelHealthy, resetHealthCache } from '../src/health-monitor.js'

describe('health-monitor', () => {
  afterEach(() => {
    resetHealthCache()
  })

  it('returns unknown for unchecked models', () => {
    const h = getModelHealth('nonexistent')
    expect(h.status).toBe('unknown')
  })

  it('getAllModelHealth returns empty map initially', () => {
    const all = getAllModelHealth()
    expect(Object.keys(all).length).toBe(0)
  })

  it('isModelHealthy returns true for unknown (optimistic)', () => {
    expect(isModelHealthy('unchecked-model')).toBe(true)
  })

  it('module exports expected functions', async () => {
    const mod = await import('../src/health-monitor.js')
    expect(typeof mod.startHealthMonitor).toBe('function')
    expect(typeof mod.stopHealthMonitor).toBe('function')
    expect(typeof mod.getModelHealth).toBe('function')
    expect(typeof mod.getAllModelHealth).toBe('function')
    expect(typeof mod.isModelHealthy).toBe('function')
    expect(typeof mod.resetHealthCache).toBe('function')
  })
})
