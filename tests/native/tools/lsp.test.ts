import { describe, it, expect } from 'vitest'
import { createLSPTool } from '../../../src/native/tools/lsp.js'

describe('LSP tool', () => {
  it('returns not-available with default provider', async () => {
    const tool = createLSPTool()
    const result = await tool.execute({ action: 'diagnostics', file_path: '/tmp/test.ts' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('not available')
  })

  it('requires action', async () => {
    const tool = createLSPTool()
    const result = await tool.execute({ action: '' as any, file_path: '/tmp/test.ts' })
    expect(result.isError).toBe(true)
  })

  it('requires file_path', async () => {
    const tool = createLSPTool()
    const result = await tool.execute({ action: 'hover', file_path: '' })
    expect(result.isError).toBe(true)
  })

  it('uses custom provider when available', async () => {
    const tool = createLSPTool({
      isAvailable: () => true,
      execute: async () => ({ content: 'hover info: string' }),
    })
    const result = await tool.execute({ action: 'hover', file_path: '/test.ts', line: 5, character: 10 })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('hover info')
  })

  it('has correct name', () => {
    const tool = createLSPTool()
    expect(tool.name).toBe('LSP')
  })
})
