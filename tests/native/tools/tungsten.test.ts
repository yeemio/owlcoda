import { describe, it, expect } from 'vitest'
import { createTungstenTool } from '../../../src/native/tools/tungsten.js'

describe('Tungsten tool (stub)', () => {
  const tool = createTungstenTool()

  it('returns not-available error', async () => {
    const result = await tool.execute({})
    expect(result.isError).toBe(true)
    expect(result.output).toContain('not available')
  })

  it('has correct name', () => {
    expect(tool.name).toBe('Tungsten')
  })
})
