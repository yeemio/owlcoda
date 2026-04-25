import { describe, it, expect } from 'vitest'
import { createStructuredOutputTool } from '../../../src/native/tools/structured-output.js'

describe('StructuredOutput tool', () => {
  const tool = createStructuredOutputTool()

  it('returns formatted JSON from input', async () => {
    const result = await tool.execute({ name: 'test', value: 42 })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('name')
    expect(result.output).toContain('42')
  })

  it('handles string-like input', async () => {
    const result = await tool.execute({ message: 'hello' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('hello')
  })

  it('includes metadata with structuredOutput', async () => {
    const result = await tool.execute({ a: 1 })
    expect(result.metadata).toBeDefined()
    expect((result.metadata as any).structuredOutput).toEqual({ a: 1 })
  })

  it('has correct name', () => {
    expect(tool.name).toBe('StructuredOutput')
  })
})
