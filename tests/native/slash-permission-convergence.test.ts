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

  // Regression: the reported bug — once in yolo, /mode could not switch back out.
  // /yolo set the autoApprove mirror but /mode only wrote operatingModeState.mode,
  // so the gate (tui-approval short-circuits on autoApprove) stayed stuck-open.
  it('/mode normal after /yolo clears the autoApprove mirror (switches back OUT of yolo)', async () => {
    const { conversation, approveState } = setup()
    await handleSlashCommand('/yolo on', conversation, usage, {} as any, approveState)
    expect(approveState.autoApprove).toBe(true)
    await handleSlashCommand('/mode normal', conversation, usage, {} as any, approveState)
    expect(conversation.options?.operatingModeState?.mode).toBe('normal')
    expect(approveState.autoApprove).toBe(false)
  })

  it('/mode auto after /yolo also leaves yolo (auto is not full auto-approve)', async () => {
    const { conversation, approveState } = setup()
    await handleSlashCommand('/yolo on', conversation, usage, {} as any, approveState)
    await handleSlashCommand('/mode auto', conversation, usage, {} as any, approveState)
    expect(conversation.options?.operatingModeState?.mode).toBe('auto')
    expect(approveState.autoApprove).toBe(false)
  })

  it('/plan after /yolo leaves yolo and clears the mirror', async () => {
    const { conversation, approveState } = setup()
    await handleSlashCommand('/yolo on', conversation, usage, {} as any, approveState)
    await handleSlashCommand('/plan', conversation, usage, {} as any, approveState)
    expect(conversation.options?.operatingModeState?.mode).toBe('plan')
    expect(approveState.autoApprove).toBe(false)
  })

  it('/mode yolo turns the mirror ON (consistent the other direction)', async () => {
    const { conversation, approveState } = setup()
    await handleSlashCommand('/mode yolo', conversation, usage, {} as any, approveState)
    expect(conversation.options?.operatingModeState?.mode).toBe('yolo')
    expect(approveState.autoApprove).toBe(true)
  })

  // Regression: /mode yolo is a real, accepted mode (and the rail paints a red
  // YOLO cell), yet the no-arg hint and the invalid-mode error both listed only
  // "plan, normal, auto" — telling the user yolo wasn't switchable when it is.
  it('the no-arg /mode hint lists yolo as a switchable mode', async () => {
    const { conversation, approveState } = setup()
    await handleSlashCommand('/mode', conversation, usage, {} as any, approveState)
    expect(output()).toContain('yolo')
  })

  it('the invalid-mode error lists yolo among the expected modes', async () => {
    const { conversation, approveState } = setup()
    await handleSlashCommand('/mode turbo', conversation, usage, {} as any, approveState)
    expect(output()).toContain('yolo')
  })
})

// /plan only enters read-only plan mode when modes are enabled; with
// OWLCODA_MODES=0 the /plan handler instead defers to EnterPlanMode/ExitPlanMode
// tools. The /help text advertised "Enter read-only plan mode" unconditionally
// (only the sibling /mode line was gated), so the escape-hatch user was told
// /plan does something it doesn't.
describe('/help advertises plan mode only when modes are enabled', () => {
  const original = process.env['OWLCODA_MODES']
  afterEach(() => {
    if (original === undefined) delete process.env['OWLCODA_MODES']
    else process.env['OWLCODA_MODES'] = original
  })

  async function helpOutput(): Promise<string> {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const conversation = createConversation({ system: 'test', model: 'minimax-m27' })
    await handleSlashCommand('/help', conversation, new UsageTracker(), {} as any, { autoApprove: false })
    const out = stripAnsi(logSpy.mock.calls.flat().join('\n'))
    logSpy.mockRestore()
    return out
  }

  // /plan is demoted to a /mode alias, so /help advertises the modes through the
  // gated /mode line ("Approval mode (plan|normal|auto|yolo)…") instead of a
  // standalone /plan entry.
  it('does NOT advertise the /mode line when OWLCODA_MODES=0', async () => {
    process.env['OWLCODA_MODES'] = '0'
    expect(await helpOutput()).not.toContain('Approval mode')
  })

  it('advertises the modes (incl. plan) through /mode when modes are enabled', async () => {
    process.env['OWLCODA_MODES'] = '1'
    const out = await helpOutput()
    expect(out).toContain('Approval mode')
    expect(out).toContain('plan')
  })
})
