import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordError,
  getRecentErrors,
  getErrorCount,
  clearErrors,
  getUptime,
  suggestModelFix,
} from '../src/diagnostics.js'

describe('diagnostics', () => {
  beforeEach(() => {
    clearErrors()
  })

  it('records and retrieves errors', () => {
    recordError('/v1/messages', 'api_error', 'Connection refused')
    recordError('/v1/messages', 'timeout', 'Request timed out after 120s')

    const errors = getRecentErrors(5)
    expect(errors).toHaveLength(2)
    expect(errors[0]!.endpoint).toBe('/v1/messages')
    expect(errors[0]!.errorType).toBe('api_error')
    expect(errors[1]!.errorType).toBe('timeout')
  })

  it('limits to last N errors', () => {
    for (let i = 0; i < 25; i++) {
      recordError('/v1/messages', 'error', `Error ${i}`)
    }
    expect(getErrorCount()).toBe(20) // MAX_ERRORS = 20
    const recent = getRecentErrors(3)
    expect(recent).toHaveLength(3)
    expect(recent[2]!.message).toBe('Error 24')
  })

  it('clearErrors resets buffer', () => {
    recordError('/v1/messages', 'error', 'test')
    clearErrors()
    expect(getErrorCount()).toBe(0)
    expect(getRecentErrors()).toHaveLength(0)
  })

  it('getUptime returns positive number', () => {
    const uptime = getUptime()
    expect(uptime).toBeGreaterThanOrEqual(0)
  })

  it('suggestModelFix finds partial matches', () => {
    const suggestion = suggestModelFix('qwen', ['Qwen3.5-27B', 'gpt-oss-120b'])
    expect(suggestion).toContain('Qwen3.5-27B')
  })

  it('suggestModelFix lists available when no match', () => {
    const suggestion = suggestModelFix('nonexistent', ['model-a', 'model-b', 'model-c', 'model-d'])
    expect(suggestion).toContain('model-a')
    expect(suggestion).toContain('...')
  })

  it('records errors with suggestions', () => {
    recordError('/v1/messages', 'model_not_found', 'Model xyz not found', 'Did you mean "xyz-2b"?')
    const errors = getRecentErrors(1)
    expect(errors[0]!.suggestion).toBe('Did you mean "xyz-2b"?')
  })
})
