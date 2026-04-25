import { describe, it, expect } from 'vitest'

describe('config edge cases (via import)', async () => {
  const { normalizeModel, loadConfig } = await import('../src/config.ts')

  it('normalizeModel with missing id returns empty string id', () => {
    const m = normalizeModel({})
    expect(m.id).toBe('')
    expect(m.backendModel).toBe('')
    expect(m.aliases).toEqual([])
  })

  it('normalizeModel with numeric id handles gracefully', () => {
    const m = normalizeModel({ id: 42 as any })
    expect(m.id).toBe('')
  })

  it('normalizeModel handles null aliases', () => {
    const m = normalizeModel({ id: 'x', aliases: null })
    expect(m.aliases).toEqual([])
  })

  it('normalizeModel handles object aliases', () => {
    const m = normalizeModel({ id: 'x', aliases: { foo: 'bar' } })
    expect(m.aliases).toEqual([])
  })

  it('normalizeModel preserves contextWindow when specified', () => {
    const m = normalizeModel({ id: 'x', contextWindow: 128000 })
    expect(m.contextWindow).toBe(128000)
  })

  it('normalizeModel defaults contextWindow to 32768', () => {
    const m = normalizeModel({ id: 'x' })
    expect(m.contextWindow).toBe(32768)
  })

  it('normalizeModel with empty backendModel defaults to id', () => {
    const m = normalizeModel({ id: 'mymodel', backendModel: '' })
    expect(m.backendModel).toBe('mymodel')
  })

  it('normalizeModel preserves channel and role', () => {
    const m = normalizeModel({ id: 'x', channel: 'primary', role: 'assistant' })
    expect(m.channel).toBe('primary')
    expect(m.role).toBe('assistant')
  })

  it('normalizeModel with non-string channel returns undefined', () => {
    const m = normalizeModel({ id: 'x', channel: 123 })
    expect(m.channel).toBeUndefined()
  })

  it('normalizeModel with default=false yields undefined', () => {
    const m = normalizeModel({ id: 'x', default: false })
    expect(m.default).toBeUndefined()
  })
})
