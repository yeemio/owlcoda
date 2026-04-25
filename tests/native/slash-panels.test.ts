import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConversation } from '../../src/native/conversation.js'
import { handleSlashCommand } from '../../src/native/repl.js'
import { UsageTracker } from '../../src/native/usage.js'
import { stripAnsi } from '../../src/native/tui/colors.js'

describe('slash command panels', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let usage: UsageTracker

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    usage = new UsageTracker()
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  function output(): string {
    return stripAnsi(logSpy.mock.calls.flat().join('\n'))
  }

  it('/settings renders the settings panel and is read-only', async () => {
    const conversation = createConversation({ system: 'test', model: 'minimax-m27' })
    await handleSlashCommand('/settings', conversation, usage, { apiBaseUrl: 'http://127.0.0.1:9999' } as any)
    expect(output()).toContain('OC /settings')
    expect(output()).toContain('minimax-m27')
    expect(output()).toContain('/theme')
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
