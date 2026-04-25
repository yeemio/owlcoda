import { describe, it, expect } from 'vitest'
import { validateConfig } from '../src/config-validate.js'

describe('Config schema validation', () => {
  it('accepts valid minimal config', () => {
    const result = validateConfig({ port: 8019, host: '127.0.0.1' })
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts empty object', () => {
    const result = validateConfig({})
    expect(result.valid).toBe(true)
  })

  it('rejects non-object', () => {
    expect(validateConfig(null).valid).toBe(false)
    expect(validateConfig('string').valid).toBe(false)
    expect(validateConfig(42).valid).toBe(false)
  })

  it('catches port out of range', () => {
    const result = validateConfig({ port: 0 })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('port')
  })

  it('catches port wrong type', () => {
    const result = validateConfig({ port: 'fast' })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('number')
  })

  it('catches invalid logLevel', () => {
    const result = validateConfig({ logLevel: 'verbose' })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('logLevel')
  })

  it('accepts valid logLevel', () => {
    const result = validateConfig({ logLevel: 'debug' })
    expect(result.valid).toBe(true)
  })

  it('catches non-string host', () => {
    const result = validateConfig({ host: 123 })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('host')
  })

  it('catches non-array models', () => {
    const result = validateConfig({ models: 'not-array' })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('models')
  })

  it('catches models with missing id', () => {
    const result = validateConfig({ models: [{ backendModel: 'test' }] })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('models[0].id')
  })

  it('catches non-object middleware', () => {
    const result = validateConfig({ middleware: 'nope' })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('middleware')
  })

  it('validates middleware sub-fields', () => {
    const result = validateConfig({ middleware: { rateLimitRpm: 'fast' } })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('rateLimitRpm')
  })

  it('accepts valid middleware config', () => {
    const result = validateConfig({ middleware: { rateLimitRpm: 60, retryMaxAttempts: 3 } })
    expect(result.valid).toBe(true)
  })

  it('catches invalid responseModelStyle', () => {
    const result = validateConfig({ responseModelStyle: 'custom' })
    expect(result.valid).toBe(false)
  })

  it('accepts adminToken as string', () => {
    const result = validateConfig({ adminToken: 'secret123' })
    expect(result.valid).toBe(true)
  })

  it('catches logFileMaxBytes too small', () => {
    const result = validateConfig({ logFileMaxBytes: 10 })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('logFileMaxBytes')
  })

  it('reports multiple errors at once', () => {
    const result = validateConfig({ port: 'x', host: 123, logLevel: 'verbose' })
    expect(result.errors.length).toBeGreaterThanOrEqual(3)
  })
})
