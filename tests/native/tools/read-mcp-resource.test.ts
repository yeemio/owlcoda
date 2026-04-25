import { describe, it, expect } from 'vitest'
import { createReadMcpResourceTool } from '../../../src/native/tools/read-mcp-resource.js'

describe('ReadMcpResource tool', () => {
  it('returns not-connected with default provider', async () => {
    const tool = createReadMcpResourceTool()
    const result = await tool.execute({ server_name: 'test-srv', uri: 'file:///test' })
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/not (connected|available)/i)
  })

  it('requires server_name', async () => {
    const tool = createReadMcpResourceTool()
    const result = await tool.execute({ server_name: '', uri: 'x' })
    expect(result.isError).toBe(true)
  })

  it('requires uri', async () => {
    const tool = createReadMcpResourceTool()
    const result = await tool.execute({ server_name: 'srv', uri: '' })
    expect(result.isError).toBe(true)
  })

  it('uses custom provider', async () => {
    const tool = createReadMcpResourceTool({
      isConnected: () => true,
      readResource: async () => ({ content: 'resource data', mimeType: 'text/plain' }),
    })
    const result = await tool.execute({ server_name: 'srv', uri: 'file:///data' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('resource data')
  })

  it('has correct name', () => {
    const tool = createReadMcpResourceTool()
    expect(tool.name).toBe('ReadMcpResource')
  })
})
