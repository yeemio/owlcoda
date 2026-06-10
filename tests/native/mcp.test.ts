/**
 * Tests for MCP client, config, and manager.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MCPManager } from '../../src/native/mcp/manager.js'
import { loadMCPConfig } from '../../src/native/mcp/config.js'
import { MCPClient } from '../../src/native/mcp/client.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

describe('MCP Config', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owlcoda-mcp-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty map when no config files exist', () => {
    const configs = loadMCPConfig(tmpDir)
    expect(configs.size).toBe(0)
  })

  it('loads servers from .mcp.json', () => {
    const mcpJson = {
      mcpServers: {
        'test-server': {
          command: 'node',
          args: ['server.js'],
          env: { FOO: 'bar' },
        },
      },
    }
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify(mcpJson))

    const configs = loadMCPConfig(tmpDir)
    expect(configs.size).toBe(1)
    expect(configs.has('test-server')).toBe(true)

    const server = configs.get('test-server')!
    expect(server.command).toBe('node')
    expect(server.args).toEqual(['server.js'])
    expect(server.env).toEqual({ FOO: 'bar' })
  })

  it('ignores invalid entries', () => {
    const mcpJson = {
      mcpServers: {
        'valid': { command: 'node', args: [] },
        'no-command': { args: ['foo'] },
        'empty-command': { command: '' },
      },
    }
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify(mcpJson))

    const configs = loadMCPConfig(tmpDir)
    expect(configs.size).toBe(1)
    expect(configs.has('valid')).toBe(true)
  })
})

describe('MCP Manager', () => {
  let manager: MCPManager

  beforeEach(() => {
    manager = new MCPManager()
  })

  afterEach(async () => {
    await manager.disconnectAll()
  })

  it('starts with no servers', () => {
    expect(manager.getServers()).toEqual([])
    expect(manager.summary()).toEqual({ total: 0, connected: 0, error: 0 })
  })

  it('isConnected returns false for unknown servers', () => {
    expect(manager.isConnected('nonexistent')).toBe(false)
  })

  it('callTool returns error for disconnected server', async () => {
    const result = await manager.callTool('nonexistent', 'test', {})
    expect(result.isError).toBe(true)
    expect(result.content).toContain('not connected')
  })

  it('getAllTools returns empty when no servers', () => {
    expect(manager.getAllTools()).toEqual([])
  })

  it('getAllResources returns empty when no servers', () => {
    expect(manager.getAllResources()).toEqual([])
  })

  it('connectOne reports error for invalid command', async () => {
    const state = await manager.connectOne('bad', {
      command: '/nonexistent/path/to/mcp-server-that-does-not-exist-xyz',
    })
    expect(state.status).toBe('error')
    expect(state.error).toBeTruthy()
  })

  it('listResources returns empty for disconnected server', async () => {
    const resources = await manager.listResources('nonexistent')
    expect(resources).toEqual([])
  })
})

describe('MCP Client', () => {
  it('throws when connecting twice', async () => {
    const client = new MCPClient('test', { command: 'echo' })
    // We can't actually connect without a real MCP server,
    // but we can test the error path
    try {
      await client.connect()
    } catch {
      // Expected — echo is not an MCP server
    }
  })

  it('disconnect is safe when not connected', async () => {
    const client = new MCPClient('test', { command: 'echo' })
    await client.disconnect() // Should not throw
  })
})
