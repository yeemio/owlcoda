import { describe, it, expect } from 'vitest'
import { createReadMcpResourceTool } from '../../../src/native/tools/read-mcp-resource.js'

describe('ReadMcpResource tool', () => {
  it('returns not-connected with default provider', async () => {
    const tool = createReadMcpResourceTool()
    const result = await tool.execute({ server_name: 'test-srv', uri: 'mcp://test' })
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/not (connected|available)/i)
  })

  it('requires server_name', async () => {
    const tool = createReadMcpResourceTool()
    const result = await tool.execute({ server_name: '', uri: 'x' })
    expect(result.isError).toBe(true)
  })

  // 2026-06-13 dogfood (kimi-code on owlrunkit): the model called
  // ReadMcpResource with `server:` (not `server_name:`) and a file:// URI
  // ~8 times, each rejected by a bare "server_name is required" that gave
  // no way to self-correct. Two hardenings so a weak model recovers on the
  // next attempt instead of burning a loop:
  it('coerces the common `server` alias so a near-miss call succeeds', async () => {
    const tool = createReadMcpResourceTool({
      isConnected: () => true,
      readResource: async () => ({ content: 'ok', mimeType: 'text/plain' }),
    })
    const result = await tool.execute({ server: 'srv', uri: 'mcp://x' } as never)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('ok')
  })

  it('lists received keys and names the right param when server_name is absent', async () => {
    const tool = createReadMcpResourceTool()
    const result = await tool.execute({ srv: 'tools', uri: 'x' } as never)
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/server_name/)
    expect(result.output).toMatch(/srv|received/i)
  })

  it('redirects file:// URIs to the Read tool', async () => {
    const tool = createReadMcpResourceTool()
    const result = await tool.execute({ server_name: 'tools', uri: 'file:///etc/hosts' })
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/Read tool/i)
  })

  // Error returns carry a failureCategory so the loop guard can aggregate
  // arg-varying failures by CLASS (the model retried with a different uri
  // each time, so signature/intentKey never matched — only the class does).
  it('tags error returns with a failureCategory', async () => {
    const tool = createReadMcpResourceTool()
    const notConnected = await tool.execute({ server_name: 'nope', uri: 'mcp://x' })
    expect(notConnected.metadata?.['failureCategory']).toBe('mcp:not-connected')

    const fileUri = await tool.execute({ server_name: 'tools', uri: 'file:///etc/hosts' })
    expect(fileUri.metadata?.['failureCategory']).toBe('mcp:file-uri')

    const badParams = await tool.execute({ srv: 'x', uri: 'y' } as never)
    expect(badParams.metadata?.['failureCategory']).toBe('mcp:bad-params')
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
    const result = await tool.execute({ server_name: 'srv', uri: 'mcp://data' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('resource data')
  })

  it('has correct name', () => {
    const tool = createReadMcpResourceTool()
    expect(tool.name).toBe('ReadMcpResource')
  })
})
