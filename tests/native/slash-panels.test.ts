import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConversation } from '../../src/native/conversation.js'
import { handleSlashCommand } from '../../src/native/repl.js'
import { UsageTracker } from '../../src/native/usage.js'
import { stripAnsi } from '../../src/native/tui/colors.js'
import { installIsolatedOwlCodaHome } from './isolated-owlcoda-home.js'

describe('slash command panels', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let usage: UsageTracker
  let restoreOwlCodaHome: (() => void) | undefined

  beforeEach(() => {
    restoreOwlCodaHome = installIsolatedOwlCodaHome('owlcoda-slash-panels-test-')
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    usage = new UsageTracker()
  })

  afterEach(() => {
    logSpy.mockRestore()
    restoreOwlCodaHome?.()
    restoreOwlCodaHome = undefined
  })

  function output(): string {
    return stripAnsi(logSpy.mock.calls.flat().join('\n'))
  }

  it('/config shows config + the permissions/theme absorbed from the old /settings', async () => {
    const conversation = createConversation({ system: 'test', model: 'minimax-m27' })
    await handleSlashCommand('/config', conversation, usage, { apiBaseUrl: 'http://127.0.0.1:9999' } as any, { autoApprove: false })
    const out = output()
    expect(out).toContain('minimax-m27')
    expect(out).toContain('Permissions')
    expect(out).toContain('Theme')
  })

  it('the old /settings name redirects to /config', async () => {
    const conversation = createConversation({ system: 'test', model: 'minimax-m27' })
    await handleSlashCommand('/settings', conversation, usage)
    expect(output()).toContain('/config')
  })

  it('/mcp renders empty-state panel when no manager is configured', async () => {
    const conversation = createConversation({ system: 'test', model: 'minimax-m27' })
    await handleSlashCommand('/mcp', conversation, usage)
    expect(output()).toContain('OC /mcp')
    expect(output()).toContain('No MCP servers configured')
  })

  it('/sessions renders the sessions panel surface', async () => {
    const conversation = createConversation({ system: 'test', model: 'minimax-m27' })
    await handleSlashCommand('/sessions', conversation, usage)
    expect(output()).toContain('OC /sessions')
  })
})
