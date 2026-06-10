import { describe, it, expect } from 'vitest'
import { translateTools, translateToolChoice } from '../src/translate/tools.js'

describe('translateTools', () => {
  it('translates tool definitions', () => {
    const result = translateTools([{
      name: 'calculator',
      description: 'Calculate math',
      input_schema: { type: 'object', properties: { expr: { type: 'string' } } },
      cache_control: { type: 'ephemeral' },
    }])
    expect(result).toEqual([{
      type: 'function',
      function: {
        name: 'calculator',
        description: 'Calculate math',
        parameters: { type: 'object', properties: { expr: { type: 'string' } } },
      },
    }])
  })

  it('handles tool without description', () => {
    const result = translateTools([{ name: 'test', input_schema: { type: 'object' } }])
    expect(result[0].function.name).toBe('test')
    expect(result[0].function.description).toBeUndefined()
  })
})

describe('translateToolChoice', () => {
  it('returns undefined for undefined', () => {
    expect(translateToolChoice(undefined)).toBeUndefined()
  })
  it('maps auto', () => {
    expect(translateToolChoice({ type: 'auto' })).toBe('auto')
  })
  it('maps any to required', () => {
    expect(translateToolChoice({ type: 'any' })).toBe('required')
  })
  it('maps none', () => {
    expect(translateToolChoice({ type: 'none' })).toBe('none')
  })
  it('maps specific tool', () => {
    expect(translateToolChoice({ type: 'tool', name: 'Bash' })).toEqual(
      { type: 'function', function: { name: 'Bash' } }
    )
  })
})
