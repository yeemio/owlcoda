import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordSuccess, recordFailure, isCircuitOpen,
  getCircuitState, getAllCircuitStates, resetCircuitBreaker,
  configureCircuitBreaker,
} from '../src/middleware/circuit-breaker.js'

describe('circuit-breaker', () => {
  beforeEach(() => {
    resetCircuitBreaker()
  })

  it('starts closed', () => {
    expect(getCircuitState('model-a').state).toBe('closed')
  })

  it('stays closed under threshold', () => {
    for (let i = 0; i < 4; i++) recordFailure('model-a')
    expect(getCircuitState('model-a').state).toBe('closed')
    expect(isCircuitOpen('model-a')).toBe(false)
  })

  it('opens after reaching threshold', () => {
    for (let i = 0; i < 5; i++) recordFailure('model-a')
    expect(getCircuitState('model-a').state).toBe('open')
    expect(isCircuitOpen('model-a')).toBe(true)
  })

  it('resets on success', () => {
    for (let i = 0; i < 5; i++) recordFailure('model-a')
    recordSuccess('model-a')
    expect(getCircuitState('model-a').state).toBe('closed')
    expect(getCircuitState('model-a').failures).toBe(0)
  })

  it('isolates per model', () => {
    for (let i = 0; i < 5; i++) recordFailure('model-a')
    expect(isCircuitOpen('model-a')).toBe(true)
    expect(isCircuitOpen('model-b')).toBe(false)
  })

  it('configureCircuitBreaker changes threshold', () => {
    configureCircuitBreaker({ threshold: 2 })
    recordFailure('model-a')
    recordFailure('model-a')
    expect(getCircuitState('model-a').state).toBe('open')
  })

  it('getAllCircuitStates returns all models', () => {
    recordFailure('x')
    recordFailure('y')
    const all = getAllCircuitStates()
    expect(Object.keys(all)).toContain('x')
    expect(Object.keys(all)).toContain('y')
  })

  it('transitions to half-open after cooldown', () => {
    configureCircuitBreaker({ cooldownMs: 50 }) // 50ms cooldown for test
    for (let i = 0; i < 5; i++) recordFailure('model-a')
    expect(isCircuitOpen('model-a')).toBe(true)
    // Wait for cooldown
    return new Promise<void>(resolve => {
      setTimeout(() => {
        expect(isCircuitOpen('model-a')).toBe(false) // should be half-open now
        expect(getCircuitState('model-a').state).toBe('half-open')
        resolve()
      }, 100)
    })
  })
})
