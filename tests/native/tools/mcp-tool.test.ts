import { describe, it, expect } from 'vitest'
import { createMCPTool } from '../../../src/native/tools/mcp-tool.js'

describe('MCPTool', () => {
  it('returns not-connected with default provider', async () => {
    const tool = createMCPTool()
    const result = await tool.execute({ server_name: 'test-server', tool_name: 'test-tool' })
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/not (connected|available)/i)
  })

  it('requires server_name', async () => {
    const tool = createMCPTool()
    const result = await tool.execute({ server_name: '', tool_name: 'test' })
    expect(result.isError).toBe(true)
  })

  it('requires tool_name', async () => {
    const tool = createMCPTool()
    const result = await tool.execute({ server_name: 'test', tool_name: '' })
    expect(result.isError).toBe(true)
  })

  it('uses custom provider when connected', async () => {
    const tool = createMCPTool({
      isConnected: () => true,
      callTool: async (_server, _tool, _input) => ({ content: 'custom result' }),
    })
    const result = await tool.execute({ server_name: 'srv', tool_name: 'mytool', arguments: { x: 1 } })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('custom result')
  })

  it('has correct name', () => {
    const tool = createMCPTool()
    expect(tool.name).toBe('MCPTool')
  })
})
