/**
 * Tests for the 0.13.59 schema-error helper. Pin: missing-field
 * detection for write/edit, structured error output shape, the "do
 * not retry the same shape" instruction, and 200-char input echo
 * truncation.
 */
import { describe, expect, it } from 'vitest'
import {
  buildSchemaError,
  checkEditRequiredFields,
  checkWriteRequiredFields,
  predictSchemaFailure,
} from '../../../src/native/tools/tool-schema-error.js'

describe('checkWriteRequiredFields', () => {
  it('flags both fields when input is null', () => {
    expect(checkWriteRequiredFields(null)).toEqual(['path', 'content'])
  })

  it('flags both fields when input is empty object', () => {
    expect(checkWriteRequiredFields({})).toEqual(['path', 'content'])
  })

  it('flags missing path', () => {
    expect(checkWriteRequiredFields({ content: 'x' })).toEqual(['path'])
  })

  it('flags empty path string', () => {
    expect(checkWriteRequiredFields({ path: '', content: 'x' })).toEqual(['path'])
  })

  it('flags missing content', () => {
    expect(checkWriteRequiredFields({ path: '/tmp/x' })).toEqual(['content'])
  })

  it('accepts empty content (intentional empty file)', () => {
    expect(checkWriteRequiredFields({ path: '/tmp/x', content: '' })).toEqual([])
  })

  it('passes when both fields present', () => {
    expect(checkWriteRequiredFields({ path: '/tmp/x', content: 'hello' })).toEqual([])
  })
})

describe('checkEditRequiredFields', () => {
  it('flags all three fields when input is empty', () => {
    expect(checkEditRequiredFields({})).toEqual(['path', 'oldStr', 'newStr'])
  })

  it('flags missing path + oldStr', () => {
    expect(checkEditRequiredFields({ newStr: 'y' })).toEqual(['path', 'oldStr'])
  })

  it('flags empty oldStr', () => {
    expect(checkEditRequiredFields({ path: '/tmp/x', oldStr: '', newStr: 'y' })).toEqual(['oldStr'])
  })

  it('accepts empty newStr (intentional deletion)', () => {
    expect(checkEditRequiredFields({ path: '/tmp/x', oldStr: 'a', newStr: '' })).toEqual([])
  })

  it('passes when all three present', () => {
    expect(checkEditRequiredFields({ path: '/tmp/x', oldStr: 'a', newStr: 'b' })).toEqual([])
  })
})

describe('buildSchemaError', () => {
  it('produces structured output naming the tool, missing fields, schema, and input echo', () => {
    const r = buildSchemaError('write', ['path', 'content'], {}, 'path: string, content: string')
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/Error: write tool called with empty or missing required field\(s\): `path`, `content`/)
    expect(r.output).toMatch(/Schema: \{ path: string, content: string \}/)
    expect(r.output).toMatch(/Received input: \{\}/)
    expect(r.output).toMatch(/Do NOT retry the same input shape/)
  })

  it('truncates very long input echoes at 200 chars', () => {
    const huge = { path: 'x'.repeat(500) }
    const r = buildSchemaError('write', ['content'], huge, 'path, content')
    const m = r.output.match(/Received input: ([^\n]+)/)
    expect(m).not.toBeNull()
    // The truncated body itself <= 200 chars, with '...' suffix marker
    expect(m![1]!.length).toBeLessThanOrEqual(200)
    expect(m![1]).toMatch(/\.\.\.$/)
  })

  it('attaches schemaError + missingFields metadata', () => {
    const r = buildSchemaError('edit', ['oldStr'], { path: '/tmp/x', newStr: 'y' }, 'path, oldStr, newStr')
    expect(r.metadata?.['schemaError']).toBe(true)
    expect(r.metadata?.['toolName']).toBe('edit')
    expect(r.metadata?.['missingFields']).toEqual(['oldStr'])
  })

  it('handles undefined input gracefully', () => {
    const r = buildSchemaError('write', ['path'], undefined, 'path, content')
    expect(r.output).toMatch(/Received input: null/)
  })
})

// 0.13.62 (B): pre-flight schema check used by executeTools to
// short-circuit empty-input retry loops at the dispatcher level.
describe('predictSchemaFailure (0.13.62)', () => {
  it('returns null for tools without a checker', () => {
    expect(predictSchemaFailure('bash', { command: 'ls' })).toBeNull()
    expect(predictSchemaFailure('grep', { pattern: 'foo' })).toBeNull()
  })

  it('returns null for well-formed write input', () => {
    expect(
      predictSchemaFailure('write', { path: '/tmp/x', content: 'ok' }),
    ).toBeNull()
  })

  it('returns null for well-formed edit input', () => {
    expect(
      predictSchemaFailure('edit', { path: '/tmp/x', oldStr: 'a', newStr: 'b' }),
    ).toBeNull()
  })

  it('flags write({}) with both fields missing', () => {
    const r = predictSchemaFailure('write', {})
    expect(r).not.toBeNull()
    expect(r!.missingFields.sort()).toEqual(['content', 'path'])
  })

  it('flags edit({}) with all three fields missing', () => {
    const r = predictSchemaFailure('edit', {})
    expect(r).not.toBeNull()
    expect(r!.missingFields.sort()).toEqual(['newStr', 'oldStr', 'path'])
  })

  it('flags partial input (one missing field)', () => {
    expect(predictSchemaFailure('write', { path: '/tmp/x' })?.missingFields).toEqual(['content'])
    expect(predictSchemaFailure('edit', { path: '/tmp/x', oldStr: 'a' })?.missingFields).toEqual(['newStr'])
  })

  it('produces stable dedup key when called twice with same shape', () => {
    const r1 = predictSchemaFailure('write', {})
    const r2 = predictSchemaFailure('write', {})
    expect(r1).not.toBeNull()
    expect(r2).not.toBeNull()
    const key1 = `write:${[...r1!.missingFields].sort().join(',')}`
    const key2 = `write:${[...r2!.missingFields].sort().join(',')}`
    expect(key1).toBe(key2)
    expect(key1).toBe('write:content,path')
  })
})
