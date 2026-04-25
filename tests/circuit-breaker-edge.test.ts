/**
 * Edge case tests for circuit breaker — state transitions, independence, reset.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  configureCircuitBreaker,
  recordSuccess,
  recordFailure,
  isCircuitOpen,
  getCircuitState,
  getAllCircuitStates,
  resetCircuitBreaker,
} from '../src/middleware/circuit-breaker.js'

beforeEach(() => {
  resetCircuitBreaker()
})

describe('circuit breaker edge cases', () => {
  it('starts closed with zero failures', () => {
    const s = getCircuitState('fresh')
    expect(s.state).toBe('closed')
    expect(s.failures).toBe(0)
  })

  it('opens after threshold failures', () => {
    configureCircuitBreaker({ threshold: 3 })
    recordFailure('model-x')
    recordFailure('model-x')
    expect(getCircuitState('model-x').state).toBe('closed')
    recordFailure('model-x')
    expect(getCircuitState('model-x').state).toBe('open')
    expect(isCircuitOpen('model-x')).toBe(true)
  })

  it('success resets failures and closes breaker', () => {
    configureCircuitBreaker({ threshold: 2 })
    recordFailure('model-y')
    recordFailure('model-y')
    expect(getCircuitState('model-y').state).toBe('open')
    recordSuccess('model-y')
    expect(getCircuitState('model-y').state).toBe('closed')
    expect(getCircuitState('model-y').failures).toBe(0)
  })

  it('concurrent model breakers are independent', () => {
    configureCircuitBreaker({ threshold: 2 })
    recordFailure('a')
    recordFailure('a')
    recordFailure('b')
    expect(getCircuitState('a').state).toBe('open')
    expect(getCircuitState('b').state).toBe('closed')
  })

  it('getAllCircuitStates returns all tracked models', () => {
    recordFailure('p')
    recordSuccess('q')
    const states = getAllCircuitStates()
    expect('p' in states).toBe(true)
    expect('q' in states).toBe(true)
  })

  it('resetCircuitBreaker clears all state', () => {
    recordFailure('model-z')
    resetCircuitBreaker()
    const s = getCircuitState('model-z')
    expect(s.state).toBe('closed')
    expect(s.failures).toBe(0)
  })

  it('does not open if failures below threshold', () => {
    configureCircuitBreaker({ threshold: 10 })
    for (let i = 0; i < 9; i++) recordFailure('patient')
    expect(getCircuitState('patient').state).toBe('closed')
    expect(isCircuitOpen('patient')).toBe(false)
  })

  it('half-open allows one request through after cooldown', () => {
    configureCircuitBreaker({ threshold: 1, cooldownMs: 0 })
    recordFailure('fast')
    expect(getCircuitState('fast').state).toBe('open')
    // With cooldownMs=0, isCircuitOpen immediately transitions to half-open
    expect(isCircuitOpen('fast')).toBe(false)
    expect(getCircuitState('fast').state).toBe('half-open')
  })
})
