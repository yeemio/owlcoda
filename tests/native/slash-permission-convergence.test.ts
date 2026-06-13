import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createConversation } from '../../src/native/conversation.js'
import { handleSlashCommand } from '../../src/native/repl.js'
import { UsageTracker } from '../../src/native/usage.js'
import { stripAnsi } from '../../src/native/tui/colors.js'

// Slice 1: /yolo, /approve, /plan become shorthands into the single /mode axis
// (the one source of truth = operatingModeState.mode). approveState.autoApprove
// is kept as a derived mirror so the existing TUI approval plumbing stays in sync.

describe('permission commands converge on the single /mode axis', () => {
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
  function setup() {
    const conversation = createConversation({ system: 'test', model: 'minimax-m27' })
    const approveState = { autoApprove: false }
    return { conversation, approveState }
  }

  it('/yolo on sets operating mode to yolo and mirrors autoApprove', async () => {
    const { conversation, approveState } = setup()
    await handleSlashCommand('/yolo on', conversation, usage, {} as any, approveState)
    expect(conversation.options?.operatingModeState?.mode).toBe('yolo')
    expect(approveState.autoApprove).toBe(true)
  })

  it('/yolo off returns to normal mode and clears the autoApprove mirror', async () => {
    const { conversation, approveState } = setup()
    await handleSlashCommand('/yolo on', conversation, usage, {} as any, approveState)
    await handleSlashCommand('/yolo off', conversation, usage, {} as any, approveState)
    expect(conversation.options?.operatingModeState?.mode).toBe('normal')
    expect(approveState.autoApprove).toBe(false)
  })

  it('/approve on is the same single-axis shortcut (mode=yolo)', async () => {
    const { conversation, approveState } = setup()
    await handleSlashCommand('/approve on', conversation, usage, {} as any, approveState)
    expect(conversation.options?.operatingModeState?.mode).toBe('yolo')
    expect(approveState.autoApprove).toBe(true)
  })

  it('/plan enters plan mode (functional shortcut, not a status-only shell)', async () => {
    const { conversation, approveState } = setup()
    await handleSlashCommand('/plan', conversation, usage, {} as any, approveState)
    expect(conversation.options?.operatingModeState?.mode).toBe('plan')
  })

  it('/plan off leaves plan mode back to normal', async () => {
    const { conversation, approveState } = setup()
    await handleSlashCommand('/plan', conversation, usage, {} as any, approveState)
    await handleSlashCommand('/plan off', conversation, usage, {} as any, approveState)
    expect(conversation.options?.operatingModeState?.mode).toBe('normal')
  })

  it('/permissions shows the current operating mode (orthogonal rules view)', async () => {
    const { conversation, approveState } = setup()
    await handleSlashCommand('/mode plan', conversation, usage, {} as any, approveState)
    await handleSlashCommand('/permissions', conversation, usage, {} as any, approveState)
    expect(output().toLowerCase()).toContain('plan')
  })
})
