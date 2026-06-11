import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearRecordedToolOutputs,
  getRecordedToolOutput,
  recordFullToolOutput,
} from '../../src/native/tui/chrome.js'
import { SLASH_COMMANDS, handleSlashCommand } from '../../src/native/slash-commands.js'
import { createConversation } from '../../src/native/conversation.js'
import { UsageTracker } from '../../src/native/usage.js'
import { stripAnsi } from '../../src/native/tui/colors.js'

// Chrome spec S1: collapse never loses data — /expand re-prints the full
// recorded output of a recent tool call (interactive in-place expansion is
// the future C-path; this is the static recall valve).

describe('full tool output recorder', () => {
  afterEach(() => clearRecordedToolOutputs())

  it('records and recalls most-recent-first', () => {
    recordFullToolOutput('bash', 'first output', false)
    recordFullToolOutput('grep', 'second output', true)
    expect(getRecordedToolOutput(0)?.output).toBe('second output')
    expect(getRecordedToolOutput(0)?.isError).toBe(true)
    expect(getRecordedToolOutput(1)?.name).toBe('bash')
    expect(getRecordedToolOutput(2)).toBeNull()
  })
})

describe('/expand slash command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let usage: UsageTracker

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    usage = new UsageTracker()
  })

  afterEach(() => {
    logSpy.mockRestore()
    clearRecordedToolOutputs()
  })

  function output(): string {
    return stripAnsi(logSpy.mock.calls.flat().join('\n'))
  }

  it('is registered in SLASH_COMMANDS', () => {
    expect(SLASH_COMMANDS).toContain('/expand')
  })

  it('prints the full recorded output of the last tool call', async () => {
    recordFullToolOutput('bash', 'line A\nline B\nline C', false)
    const conversation = createConversation({ system: '', model: 'test-model' })
    const handled = await handleSlashCommand('/expand', conversation, usage)
    expect(handled).toBe(true)
    expect(output()).toContain('line A')
    expect(output()).toContain('line C')
  })

  it('explains itself when nothing is recorded', async () => {
    const conversation = createConversation({ system: '', model: 'test-model' })
    const handled = await handleSlashCommand('/expand', conversation, usage)
    expect(handled).toBe(true)
    expect(output().toLowerCase()).toContain('no tool output')
  })
})
