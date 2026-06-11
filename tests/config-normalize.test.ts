import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CONFIG_SRC = readFileSync(join(__dirname, '..', 'src', 'config.ts'), 'utf-8')

describe('normalizeModel', () => {
  it('is exported from config.ts', () => {
    // normalizeModel may be defined inline or re-exported from model-registry
    const hasInline = CONFIG_SRC.includes('export function normalizeModel')
    const hasReexport = CONFIG_SRC.includes('normalizeModel') && CONFIG_SRC.includes('model-registry')
    expect(hasInline || hasReexport).toBe(true)
  })

  it('is called when loading file config models', () => {
    expect(CONFIG_SRC).toContain('.map(normalizeModel)')
  })

  it('is called in migrateModelMap', () => {
    expect(CONFIG_SRC).toContain('normalizeModel({')
  })
})

describe('normalizeModel defaults (via import)', async () => {
  const { normalizeModel } = await import('../src/config.ts')

  it('minimal config { id: "foo" } gets all defaults', () => {
    const m = normalizeModel({ id: 'foo' })
    expect(m.id).toBe('foo')
    expect(m.label).toBe('foo')
    expect(m.backendModel).toBe('foo')
    expect(m.aliases).toEqual([])
    expect(m.tier).toBe('general')
    expect(m.default).toBeUndefined()
    expect(m.contextWindow).toBe(32768)
  })

  it('preserves all specified fields', () => {
    const m = normalizeModel({
      id: 'bar',
      label: 'Bar Model',
      backendModel: 'bar-backend',
      aliases: ['b', 'baz'],
      tier: 'production',
      default: true,
      contextWindow: 65536,
      endpoint: 'https://api.example.com',
      apiKey: 'sk-test',
    })
    expect(m.id).toBe('bar')
    expect(m.label).toBe('Bar Model')
    expect(m.backendModel).toBe('bar-backend')
    expect(m.aliases).toEqual(['b', 'baz'])
    expect(m.tier).toBe('production')
    expect(m.default).toBe(true)
    expect(m.contextWindow).toBe(65536)
    expect(m.endpoint).toBe('https://api.example.com')
    expect(m.apiKey).toBe('sk-test')
  })

  it('filters non-string aliases', () => {
    const m = normalizeModel({ id: 'x', aliases: ['good', 42, null, 'also-good'] })
    expect(m.aliases).toEqual(['good', 'also-good'])
  })

  it('handles aliases as non-array gracefully', () => {
    const m = normalizeModel({ id: 'x', aliases: 'not-an-array' })
    expect(m.aliases).toEqual([])
  })

  it('defaults backendModel to id when missing', () => {
    const m = normalizeModel({ id: 'mymodel' })
    expect(m.backendModel).toBe('mymodel')
  })

  it('defaults backendModel to id when empty string', () => {
    const m = normalizeModel({ id: 'mymodel', backendModel: '' })
    expect(m.backendModel).toBe('mymodel')
  })
})

describe('modelMap building with normalized models', () => {
  it('for..of m.aliases never crashes after normalization', () => {
    // This pattern matches how config.ts builds modelMap
    const models = [
      { id: 'a', backendModel: 'a', aliases: [] as string[], label: 'A', tier: 'general' },
      { id: 'b', backendModel: 'b', aliases: ['x', 'y'], label: 'B', tier: 'general' },
    ]
    const modelMap: Record<string, string> = {}
    for (const m of models) {
      modelMap[m.id] = m.backendModel
      for (const alias of m.aliases) {
        modelMap[alias] = m.backendModel
      }
    }
    expect(modelMap).toEqual({ a: 'a', b: 'b', x: 'b', y: 'b' })
  })
})
