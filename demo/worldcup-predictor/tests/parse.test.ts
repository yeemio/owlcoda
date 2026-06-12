import { describe, expect, it } from 'vitest'
import { extractJson } from '../server/framework/parse.js'

describe('extractJson', () => {
  it('parses a bare JSON object', () => {
    expect(extractJson<{ a: number }>('{"a": 1}')).toEqual({ a: 1 })
  })

  it('strips code fences and surrounding prose', () => {
    const text = '好的,结果如下:\n```json\n{"role": "pro", "verdict": "lean"}\n```\n以上。'
    expect(extractJson(text)).toEqual({ role: 'pro', verdict: 'lean' })
  })

  it('handles nested braces and braces inside strings', () => {
    const text = 'x {"a": {"b": "c} {"}, "d": [1, 2]} trailing {"ignored": true}'
    expect(extractJson(text)).toEqual({ a: { b: 'c} {' }, d: [1, 2] })
  })

  it('returns null for unparseable text', () => {
    expect(extractJson('no json here')).toBeNull()
    expect(extractJson('{"broken": ')).toBeNull()
  })
})
