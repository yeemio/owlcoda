import { describe, it, expect } from 'vitest'
import { createListMcpResourcesTool } from '../../../src/native/tools/list-mcp-resources.js'

describe('ListMcpResources tool', () => {
  it('returns not-connected with default provider', async () => {
    const tool = createListMcpResourcesTool()
    const result = await tool.execute({ server_name: 'test-srv' })
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/not (connected|available)/i)
  })

  it('requires server_name', async () => {
    const tool = createListMcpResourcesTool()
    const result = await tool.execute({ server_name: '' })
    expect(result.isError).toBe(true)
  })

  it('uses custom provider', async () => {
    const tool = createListMcpResourcesTool({
      isConnected: () => true,
      listResources: async () => [
        { uri: 'file:///test', name: 'test-resource', description: 'A test' },
      ],
    })
    const result = await tool.execute({ server_name: 'srv' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('test-resource')
  })

  it('has correct name', () => {
    const tool = createListMcpResourcesTool()
    expect(tool.name).toBe('ListMcpResources')
  })
})
