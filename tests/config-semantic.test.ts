import { describe, it, expect } from 'vitest'
import { validateSemantics, formatSemanticWarnings } from '../src/config-semantic.js'

describe('config semantic validation', () => {
  it('detects no models', () => {
    const warnings = validateSemantics({ models: [] })
    expect(warnings).toHaveLength(1)
    expect(warnings[0].code).toBe('NO_MODELS')
    expect(warnings[0].level).toBe('error')
  })

  it('detects duplicate aliases', () => {
    const warnings = validateSemantics({
      models: [
        { id: 'model-a', tier: 'balanced', aliases: ['default'] },
        { id: 'model-b', tier: 'heavy', aliases: ['default'] },
      ],
      routerUrl: 'http://localhost:8009',
    })
    const dups = warnings.filter(w => w.code === 'DUPLICATE_ALIAS')
    expect(dups).toHaveLength(1)
    expect(dups[0].message).toContain('model-a')
    expect(dups[0].message).toContain('model-b')
  })

  it('detects no default model', () => {
    const warnings = validateSemantics({
      models: [{ id: 'model-a', tier: 'balanced', aliases: [] }],
      routerUrl: 'http://localhost:8009',
    })
    const codes = warnings.map(w => w.code)
    expect(codes).toContain('NO_DEFAULT_MODEL')
  })

  it('detects invalid router URL', () => {
    const warnings = validateSemantics({
      models: [{ id: 'model-a', tier: 'balanced', aliases: [], default: true }],
      routerUrl: 'localhost:8009',
    })
    const codes = warnings.map(w => w.code)
    expect(codes).toContain('INVALID_ROUTER_URL')
  })

  it('detects trailing slash', () => {
    const warnings = validateSemantics({
      models: [{ id: 'model-a', tier: 'balanced', aliases: [], default: true }],
      routerUrl: 'http://localhost:8009/',
    })
    const codes = warnings.map(w => w.code)
    expect(codes).toContain('TRAILING_SLASH')
  })

  it('detects port conflict', () => {
    const warnings = validateSemantics({
      models: [{ id: 'model-a', tier: 'balanced', aliases: [], default: true }],
      routerUrl: 'http://localhost:8019',
      port: 8019,
    })
    const codes = warnings.map(w => w.code)
    expect(codes).toContain('PORT_CONFLICT')
  })

  it('passes valid config', () => {
    const warnings = validateSemantics({
      models: [
        { id: 'qwen2.5-32b', tier: 'balanced', aliases: ['default'], default: true },
        { id: 'llama-3.1-70b', tier: 'heavy', aliases: ['heavy'] },
      ],
      routerUrl: 'http://localhost:8009',
      port: 8019,
    })
    expect(warnings).toHaveLength(0)
  })

  it('formats warnings', () => {
    const warnings = [
      { level: 'error' as const, code: 'TEST', message: 'error msg' },
      { level: 'warn' as const, code: 'TEST2', message: 'warn msg' },
    ]
    const out = formatSemanticWarnings(warnings)
    expect(out).toContain('Configuration errors')
    expect(out).toContain('[TEST]')
    expect(out).toContain('Configuration warnings')
    expect(out).toContain('[TEST2]')
  })

  it('returns empty for no warnings', () => {
    expect(formatSemanticWarnings([])).toBe('')
  })
})
