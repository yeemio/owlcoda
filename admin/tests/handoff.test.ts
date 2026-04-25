import { describe, expect, it } from 'vitest'
import { buildHash, parseHash, pathToRoute, readHandoff } from '../src/lib/handoff'

describe('parseHash', () => {
  it('splits path and params', () => {
    expect(parseHash('#/models?select=kimi&view=issues')).toEqual({
      path: 'models',
      params: expect.any(URLSearchParams),
    })
    const { params } = parseHash('#/models?select=kimi&view=issues')
    expect(params.get('select')).toBe('kimi')
    expect(params.get('view')).toBe('issues')
  })

  it('handles empty hash', () => {
    expect(parseHash('').path).toBe('')
    expect([...parseHash('').params.keys()]).toEqual([])
  })

  it('handles path without params', () => {
    const { path, params } = parseHash('#/aliases')
    expect(path).toBe('aliases')
    expect([...params.keys()]).toEqual([])
  })
})

describe('pathToRoute', () => {
  it('maps canonical routes (from backend AdminHandoffRoute)', () => {
    expect(pathToRoute('start')).toBe('start')
    expect(pathToRoute('models')).toBe('models')
    expect(pathToRoute('aliases')).toBe('aliases')
    expect(pathToRoute('orphans')).toBe('orphans')
    expect(pathToRoute('catalog')).toBe('catalog')
  })

  it('accepts back-compat /issues/* forms', () => {
    expect(pathToRoute('issues/aliases')).toBe('aliases')
    expect(pathToRoute('issues/orphans')).toBe('orphans')
    expect(pathToRoute('issues')).toBe('issues')
  })

  it('defaults unknown paths to start', () => {
    expect(pathToRoute('')).toBe('start')
    expect(pathToRoute('something-else')).toBe('start')
  })
})

describe('readHandoff', () => {
  it('returns defaults when URL is bare', () => {
    const ctx = readHandoff({ hash: '', search: '' })
    expect(ctx.route).toBe('start')
    expect(ctx.select).toBeUndefined()
    expect(ctx.arrivedFromHandoff).toBe(false)
  })

  it('detects handoff via ?token= and parses hash', () => {
    const ctx = readHandoff({ hash: '#/aliases?select=kimi', search: '?token=ots1.abc' })
    expect(ctx.route).toBe('aliases')
    expect(ctx.select).toBe('kimi')
    expect(ctx.arrivedFromHandoff).toBe(true)
  })

  it('keeps provider preset hints for the add-model flow', () => {
    const ctx = readHandoff({ hash: '#/models?view=add&provider=bailian', search: '' })
    expect(ctx.route).toBe('models')
    expect(ctx.view).toBe('add')
    expect(ctx.provider).toBe('bailian')
  })

  it('maps view=issues to filter=issues for Models pages', () => {
    const ctx = readHandoff({ hash: '#/models?view=issues', search: '' })
    expect(ctx.filter).toBe('issues')
    expect(ctx.view).toBe('issues')
  })

  it('ignores unknown view values for filter but still carries view through', () => {
    const ctx = readHandoff({ hash: '#/models?view=overview', search: '' })
    expect(ctx.filter).toBeUndefined()
    expect(ctx.view).toBe('overview')
  })
})

describe('buildHash', () => {
  it('emits canonical handoff paths (matches server buildAdminHandoffHash)', () => {
    expect(buildHash({ route: 'start' })).toBe('#/start')
    expect(buildHash({ route: 'models' })).toBe('#/models')
    expect(buildHash({ route: 'aliases', select: 'kimi' })).toBe('#/aliases?select=kimi')
    expect(buildHash({ route: 'models', filter: 'issues' })).toBe('#/models?view=issues')
    expect(buildHash({ route: 'models', view: 'add', provider: 'openrouter' })).toBe('#/models?provider=openrouter&view=add')
  })
})
