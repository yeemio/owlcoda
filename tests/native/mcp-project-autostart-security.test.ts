import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MCPManager } from '../../src/native/mcp/manager.js'
import type { MCPServerConfig, MCPServerState } from '../../src/native/mcp/types.js'

function writeMcpConfig(path: string, command: string): void {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'mcp.json'), JSON.stringify({
    mcpServers: {
      shared: { command },
    },
  }))
}

function writeProjectMcpConfig(projectRoot: string, command: string): void {
  writeFileSync(join(projectRoot, '.mcp.json'), JSON.stringify({
    mcpServers: {
      shared: { command },
    },
  }))
}

function fakeConnectedState(name: string, config: MCPServerConfig): MCPServerState {
  return {
    name,
    config,
    status: 'connected',
    tools: [],
    resources: [],
  }
}

describe('MCP project autostart trust boundary', () => {
  let projectRoot: string
  let fakeHome: string
  let owlcodaHome: string
  let originalOwlcodaHome: string | undefined

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'owlcoda-mcp-project-'))
    fakeHome = mkdtempSync(join(tmpdir(), 'owlcoda-mcp-home-'))
    owlcodaHome = join(fakeHome, '.owlcoda')
    originalOwlcodaHome = process.env['OWLCODA_HOME']
    process.env['OWLCODA_HOME'] = owlcodaHome
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalOwlcodaHome === undefined) delete process.env['OWLCODA_HOME']
    else process.env['OWLCODA_HOME'] = originalOwlcodaHome
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  })

  function spyOnConnect(manager: MCPManager) {
    return vi.spyOn(manager, 'connectOne').mockImplementation(async (name, config) => (
      fakeConnectedState(name, config)
    ))
  }

  it('does not connect a project-controlled server during default connectAll', async () => {
    writeProjectMcpConfig(projectRoot, '/project/controlled-command')
    const manager = new MCPManager()
    const connectOne = spyOnConnect(manager)

    const states = await manager.connectAll(projectRoot)

    expect(connectOne).not.toHaveBeenCalled()
    expect(states).toEqual([
      expect.objectContaining({
        name: 'shared',
        status: 'error',
        error: expect.stringContaining('project-scoped'),
      }),
    ])
  })

  it('still connects a trusted user-level server during default connectAll', async () => {
    writeMcpConfig(owlcodaHome, '/user/trusted-command')
    const manager = new MCPManager()
    const connectOne = spyOnConnect(manager)

    await manager.connectAll(projectRoot)

    expect(connectOne).toHaveBeenCalledOnce()
    expect(connectOne).toHaveBeenCalledWith('shared', expect.objectContaining({
      command: '/user/trusted-command',
    }))
  })

  it('does not let a same-name project server shadow a trusted user server', async () => {
    writeMcpConfig(owlcodaHome, '/user/trusted-command')
    writeProjectMcpConfig(projectRoot, '/project/controlled-command')
    const manager = new MCPManager()
    const connectOne = spyOnConnect(manager)

    await manager.connectAll(projectRoot)

    expect(connectOne).toHaveBeenCalledOnce()
    expect(connectOne).toHaveBeenCalledWith('shared', expect.objectContaining({
      command: '/user/trusted-command',
    }))
  })
})
