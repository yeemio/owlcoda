import { describe, it, expect, beforeEach } from 'vitest'
import { createMcpAuthTool, resetAuthStore } from '../../../src/native/tools/mcp-auth.js'

describe('McpAuth tool', () => {
  const tool = createMcpAuthTool()

  beforeEach(() => resetAuthStore())

  it('stores token auth', async () => {
    const result = await tool.execute({
      server_name: 'test-srv',
      auth_type: 'token',
      token: 'abc123',
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('test-srv')
  })

  it('requires server_name', async () => {
    const result = await tool.execute({ server_name: '', auth_type: 'token' })
    expect(result.isError).toBe(true)
  })

  it('requires auth_type', async () => {
    const result = await tool.execute({ server_name: 'srv', auth_type: '' as any })
    expect(result.isError).toBe(true)
  })

  it('handles oauth type', async () => {
    const result = await tool.execute({
      server_name: 'oauth-srv',
      auth_type: 'oauth',
      client_id: 'client123',
      client_secret: 'secret456',
    })
    expect(result.isError).toBe(false)
  })

  it('has correct name', () => {
    expect(tool.name).toBe('McpAuth')
  })
})
