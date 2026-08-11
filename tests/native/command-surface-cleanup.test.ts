import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { createConversation } from '../../src/native/conversation.js'
import { handleSlashCommand } from '../../src/native/repl.js'
import { getSessionsDir } from '../../src/native/session.js'
import { UsageTracker } from '../../src/native/usage.js'
import { stripAnsi } from '../../src/native/tui/colors.js'
import {
  buildSlashPickerItems,
  SLASH_PICKER_HIDDEN,
} from '../../src/native/repl-shared.js'
import { SLASH_COMMANDS } from '../../src/native/slash-commands.js'
import { MODE_EFFECTS, MODE_SUMMARIES, OPERATING_MODES } from '../../src/native/modes.js'
import { installIsolatedOwlCodaHome } from './isolated-owlcoda-home.js'

const restoreTestHome = installIsolatedOwlCodaHome('owlcoda-command-surface-tests-')
const isolatedHome = process.env['OWLCODA_HOME']!
afterAll(() => {
  try {
    expect(process.env['OWLCODA_HOME']).toBe(isolatedHome)
  } finally {
    restoreTestHome()
  }
})

// The picker listed all ~85 commands, including redundant twins (/tokens=/cost,
// /themes=/theme), pure forwards (/color→/theme), and now-merged permission
// aliases (/plan, /yolo, /approve → /mode). And /mode's only description was
// "Switch operating mode" — it never said what plan/normal/auto/yolo each do.

describe('/mode explains every mode (no-arg lists them with effects)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let usage: UsageTracker
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    usage = new UsageTracker()
  })
  afterEach(() => logSpy.mockRestore())
  const output = (): string => stripAnsi(logSpy.mock.calls.flat().join('\n'))

  it('bare /mode prints each mode name AND what it does', async () => {
    const conversation = createConversation({ system: 'test', model: 'minimax-m27' })
    await handleSlashCommand('/mode', conversation, usage, {} as never, { autoApprove: false })
    const out = output()
    for (const m of OPERATING_MODES) {
      expect(out).toContain(m)
      expect(out).toContain(MODE_EFFECTS[m])
    }
  })

  it('switching to a mode still echoes that mode\'s effect', async () => {
    const conversation = createConversation({ system: 'test', model: 'minimax-m27' })
    await handleSlashCommand('/mode auto', conversation, usage, {} as never, { autoApprove: false })
    expect(output()).toContain(MODE_EFFECTS.auto)
  })
})

describe('MODE_EFFECTS / MODE_SUMMARIES cover every operating mode', () => {
  it('has an entry for each of plan/normal/auto/yolo', () => {
    for (const m of OPERATING_MODES) {
      expect(MODE_EFFECTS[m]?.length).toBeGreaterThan(0)
      expect(MODE_SUMMARIES[m]?.length).toBeGreaterThan(0)
    }
  })
})

describe('redundant commands are demoted from the picker but still work', () => {
  const picker = buildSlashPickerItems()
  const pickerLabels = new Set(picker.map((i) => i.label))

  it('hides every redundant alias from the picker', () => {
    for (const alias of Object.keys(SLASH_PICKER_HIDDEN)) {
      expect(pickerLabels.has(alias)).toBe(false)
    }
  })

  it('keeps the primary commands those aliases fold into', () => {
    for (const primary of ['/mode', '/cost', '/theme', '/status', '/compact']) {
      expect(pickerLabels.has(primary)).toBe(true)
    }
  })

  it('every hidden alias is still a known command (dispatch + autocomplete intact)', () => {
    // Demotion must NOT break muscle memory: the alias still has to be a real
    // command, just not promoted in the picker.
    for (const alias of Object.keys(SLASH_PICKER_HIDDEN)) {
      expect(SLASH_COMMANDS).toContain(alias)
    }
  })

  it('the redirect target of each hidden alias exists', () => {
    for (const target of Object.values(SLASH_PICKER_HIDDEN)) {
      const head = target.split(' ')[0]!
      expect(SLASH_COMMANDS).toContain(head)
    }
  })

  it('shrinks the visible picker by exactly the hidden count', () => {
    expect(picker.length).toBe(SLASH_COMMANDS.length - Object.keys(SLASH_PICKER_HIDDEN).length)
  })
})

describe('/reset folds /reset-circuits + /reset-budgets into one command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let usage: UsageTracker
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    usage = new UsageTracker()
  })
  afterEach(() => logSpy.mockRestore())
  const output = (): string => stripAnsi(logSpy.mock.calls.flat().join('\n'))
  const run = async (input: string): Promise<string> => {
    const conversation = createConversation({ system: 'test', model: 'minimax-m27' })
    await handleSlashCommand(input, conversation, usage, {} as never, { autoApprove: false })
    return output()
  }

  it('bare /reset resets both circuits and budgets', async () => {
    const out = await run('/reset')
    expect(out).toContain('circuit breakers')
    expect(out).toContain('error budget')
  })

  it('/reset circuits resets only circuits', async () => {
    const out = await run('/reset circuits')
    expect(out).toContain('circuit breakers')
    expect(out).not.toContain('error budget')
  })

  it('/reset budgets resets only budgets', async () => {
    const out = await run('/reset budgets')
    expect(out).toContain('error budget')
    expect(out).not.toContain('circuit breakers')
  })

  it('an unknown target shows usage', async () => {
    expect(await run('/reset wat')).toContain('Usage: /reset')
  })
})

describe('hard-removed duplicate commands redirect to their replacement', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let usage: UsageTracker
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    usage = new UsageTracker()
  })
  afterEach(() => logSpy.mockRestore())
  const run = async (input: string): Promise<string> => {
    const conversation = createConversation({ system: 'test', model: 'minimax-m27' })
    await handleSlashCommand(input, conversation, usage, {} as never, { autoApprove: false })
    return stripAnsi(logSpy.mock.calls.flat().join('\n'))
  }

  it('the deleted commands are gone from the known-command list', () => {
    for (const gone of ['/settings', '/color', '/tokens', '/reset-circuits', '/reset-budgets']) {
      expect(SLASH_COMMANDS).not.toContain(gone)
    }
  })

  it('/color points at /theme', async () => {
    expect(await run('/color')).toContain('/theme')
  })

  it('/tokens points at /cost', async () => {
    expect(await run('/tokens')).toContain('/cost')
  })

  it('a genuinely unknown command still gets the generic message', async () => {
    expect(await run('/definitely-not-a-command')).toContain('Unknown command')
  })
})

// The whole point of DEMOTING (vs deleting) is that these commands keep
// working when typed. This locks that contract: every hidden command must still
// be dispatched by a real handler — never fall through to "Unknown command" or
// the removed-command redirect. (Args chosen to avoid interactive pickers /
// destructive paths; an unreachable proxy makes the observability fetches fail
// fast to their local fallback.)
describe('every demoted command still dispatches (demoted ≠ deleted)', () => {
  const SAFE_ARG: Record<string, string> = {
    '/themes': 'dark',   // bare /themes opens an interactive picker
    '/yolo': 'off',
    '/approve': 'off',
    '/plan': 'off',
  }
  let logSpy: ReturnType<typeof vi.spyOn>
  let usage: UsageTracker
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    usage = new UsageTracker()
  })
  afterEach(() => logSpy.mockRestore())

  for (const cmd of Object.keys(SLASH_PICKER_HIDDEN)) {
    it(`${cmd} is handled by a real case`, async () => {
      expect(getSessionsDir()).toBe(`${isolatedHome}/sessions`)
      const input = SAFE_ARG[cmd] ? `${cmd} ${SAFE_ARG[cmd]}` : cmd
      const conversation = createConversation({ system: 'test', model: 'minimax-m27' })
      const handled = await handleSlashCommand(
        input, conversation, usage,
        { apiBaseUrl: 'http://127.0.0.1:1' } as never,
        { autoApprove: false },
      )
      const out = stripAnsi(logSpy.mock.calls.flat().join('\n'))
      expect(handled).toBe(true)
      expect(out).not.toContain('Unknown command')
      expect(out).not.toContain('was removed')
    })
  }
})

describe('/status surfaces the demoted diagnostics for discovery', () => {
  it('lists /dashboard and the demoted observability slices', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const conversation = createConversation({ system: 'test', model: 'minimax-m27' })
    await handleSlashCommand('/status', conversation, new UsageTracker(), {} as never, { autoApprove: false })
    const out = stripAnsi(logSpy.mock.calls.flat().join('\n'))
    logSpy.mockRestore()
    expect(out).toContain('/dashboard')
    expect(out).toContain('/slo')
  })
})
