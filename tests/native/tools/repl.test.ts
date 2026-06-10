import { describe, it, expect, vi } from 'vitest'
import { createREPLTool } from '../../../src/native/tools/repl.js'

describe('REPL tool', () => {
  const mockExecute = vi.fn(async (name: string, _input: Record<string, unknown>) => {
    if (name === 'bash') return { output: 'ok', isError: false }
    return { output: `Unknown tool: ${name}`, isError: true }
  })

  const tool = createREPLTool({ executeTool: mockExecute })

  it('executes operations in batch', async () => {
    const result = await tool.execute({
      operations: [
        { tool: 'bash', input: { command: 'echo hi' } },
        { tool: 'bash', input: { command: 'echo bye' } },
      ],
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('bash')
    expect(mockExecute).toHaveBeenCalledTimes(2)
  })

  it('reports errors for failing operations', async () => {
    mockExecute.mockClear()
    const result = await tool.execute({
      operations: [
        { tool: 'nonexistent', input: {} },
      ],
    })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('nonexistent')
  })

  it('requires non-empty operations', async () => {
    const result = await tool.execute({ operations: [] })
    expect(result.isError).toBe(true)
  })

  it('handles missing tool name', async () => {
    mockExecute.mockClear()
    const result = await tool.execute({
      operations: [{ tool: '', input: {} }],
    })
    expect(result.isError).toBe(true)
  })

  it('has correct name', () => {
    expect(tool.name).toBe('REPL')
  })
})
