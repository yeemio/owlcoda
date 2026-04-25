import { describe, it, expect } from 'vitest'
import { createToolSearchTool } from '../../../src/native/tools/tool-search.js'

describe('ToolSearch tool', () => {
  const tool = createToolSearchTool()

  it('has correct name', () => {
    expect(tool.name).toBe('ToolSearch')
  })

  it('finds tools by exact select syntax', async () => {
    const r = await tool.execute({ query: 'select:bash,grep' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('<functions>')
    expect(r.output).toContain('"name": "bash"')
    expect(r.output).toContain('"name": "grep"')
  })

  it('finds tools by keyword', async () => {
    const r = await tool.execute({ query: 'task' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('TaskCreate')
  })

  it('returns no matches message for unknown query', async () => {
    const r = await tool.execute({ query: 'xyznonexistent' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('No tools matched')
  })

  it('returns error without query', async () => {
    const r = await tool.execute({ query: '' })
    expect(r.isError).toBe(true)
  })

  it('respects max_results', async () => {
    const r = await tool.execute({ query: 'task', max_results: 2 })
    expect(r.isError).toBe(false)
    expect((r.metadata as any).matched).toBeLessThanOrEqual(2)
  })

  it('select ignores unknown tool names', async () => {
    const r = await tool.execute({ query: 'select:bash,FakeToolXyz' })
    expect(r.isError).toBe(false)
    expect((r.metadata as any).matched).toBe(1)
  })
})
