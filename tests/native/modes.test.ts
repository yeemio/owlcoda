import { afterEach, describe, expect, it } from 'vitest'
import {
  cycleOperatingMode,
  ensureOperatingModeState,
  evaluateAutoApproval,
  evaluateModeGate,
  initializeOperatingModeState,
  isModesEnabled,
  OPERATING_MODES,
  parseOperatingMode,
  resolveInitialAutoApprove,
  resolveInitialMode,
} from '../../src/native/modes.js'

describe('isModesEnabled', () => {
  const original = process.env['OWLCODA_MODES']
  afterEach(() => {
    if (original === undefined) delete process.env['OWLCODA_MODES']
    else process.env['OWLCODA_MODES'] = original
  })

  it('returns true when unset', () => {
    delete process.env['OWLCODA_MODES']
    expect(isModesEnabled()).toBe(true)
  })

  it.each(['1', 'true', 'yes', 'TRUE', 'Yes', 'anything-else'])('returns true unless explicitly disabled: %s', (v) => {
    process.env['OWLCODA_MODES'] = v
    expect(isModesEnabled()).toBe(true)
  })

  it.each(['0', 'false', 'off', '', 'no', 'FALSE', 'Off'])('returns false for explicit opt-out %s', (v) => {
    process.env['OWLCODA_MODES'] = v
    expect(isModesEnabled()).toBe(false)
  })
})

describe('mode parsing and resolution', () => {
  it('parses known modes case-insensitively', () => {
    expect(parseOperatingMode('plan')).toBe('plan')
    expect(parseOperatingMode('NORMAL')).toBe('normal')
    expect(parseOperatingMode(' auto ')).toBe('auto')
    expect(parseOperatingMode('yolo')).toBe('yolo')
    expect(parseOperatingMode('YOLO')).toBe('yolo')
  })

  it('rejects unknown modes', () => {
    expect(parseOperatingMode('turbo')).toBeNull()
    expect(parseOperatingMode(undefined)).toBeNull()
  })

  it('resolves initial mode with flag over settings over normal', () => {
    expect(resolveInitialMode({ flagMode: 'plan', settingsMode: 'auto' })).toBe('plan')
    expect(resolveInitialMode({ settingsMode: 'auto' })).toBe('auto')
    expect(resolveInitialMode({ flagMode: 'bad', settingsMode: 'bad' })).toBe('normal')
  })

  it('ensures and initializes conversation-visible state by default', () => {
    const target: { options?: { operatingModeState?: { mode: 'plan' | 'normal' | 'auto' | 'yolo' } } } = {}
    expect(ensureOperatingModeState(target, 'auto').mode).toBe('auto')
    expect(target.options?.operatingModeState?.mode).toBe('auto')

    delete process.env['OWLCODA_MODES']
    const enabled: { options?: { operatingModeState?: { mode: 'plan' | 'normal' | 'auto' | 'yolo' } } } = {}
    initializeOperatingModeState(enabled, 'plan')
    expect(enabled.options?.operatingModeState?.mode).toBe('plan')

    process.env['OWLCODA_MODES'] = '0'
    const disabled: { options?: { operatingModeState?: { mode: 'plan' | 'normal' | 'auto' | 'yolo' } } } = {}
    initializeOperatingModeState(disabled, 'plan')
    expect(disabled.options).toBeUndefined()
  })
})

describe('evaluateModeGate', () => {
  it.each(['write', 'edit', 'NotebookEdit'])('plan blocks always-mutating tool %s', (tool) => {
    expect(evaluateModeGate('plan', tool, {})).not.toBeNull()
  })

  it('plan blocks mutating bash, allows read-only bash', () => {
    expect(evaluateModeGate('plan', 'bash', { command: 'rm -rf x' })).not.toBeNull()
    expect(evaluateModeGate('plan', 'bash', { command: 'ls -la' })).toBeNull()
  })

  it('plan blocks mutating PowerShell, allows read-only PowerShell', () => {
    expect(evaluateModeGate('plan', 'PowerShell', { command: 'Set-Content x y' })).not.toBeNull()
    expect(evaluateModeGate('plan', 'PowerShell', { command: 'Get-ChildItem' })).toBeNull()
  })

  it('plan allows read-only tools', () => {
    expect(evaluateModeGate('plan', 'read', {})).toBeNull()
    expect(evaluateModeGate('plan', 'grep', { pattern: 'x' })).toBeNull()
  })

  it.each(['normal', 'auto', 'yolo'] as const)('%s never blocks (gate is additive)', (mode) => {
    expect(evaluateModeGate(mode, 'write', {})).toBeNull()
    expect(evaluateModeGate(mode, 'bash', { command: 'rm -rf x' })).toBeNull()
  })
})

describe('evaluateAutoApproval', () => {
  it('auto auto-approves low-risk tiers (internal_state, mutating)', () => {
    expect(evaluateAutoApproval('auto', 'internal_state')).toBe(true)
    expect(evaluateAutoApproval('auto', 'mutating')).toBe(true)
  })

  it('auto still prompts destructive and external_effect', () => {
    expect(evaluateAutoApproval('auto', 'destructive')).toBe(false)
    expect(evaluateAutoApproval('auto', 'external_effect')).toBe(false)
  })

  it('auto does not auto-approve safe (safe never prompts anyway)', () => {
    expect(evaluateAutoApproval('auto', 'safe')).toBe(false)
  })

  it('yolo auto-approves every tier (full-access: removes the prompt, hard gates still run upstream)', () => {
    for (const rc of ['safe', 'internal_state', 'mutating', 'destructive', 'external_effect'] as const) {
      expect(evaluateAutoApproval('yolo', rc)).toBe(true)
    }
  })

  it.each(['normal', 'plan'] as const)('%s never auto-approves any tier', (mode) => {
    for (const rc of ['safe', 'internal_state', 'mutating', 'destructive', 'external_effect'] as const) {
      expect(evaluateAutoApproval(mode, rc)).toBe(false)
    }
  })
})

describe('OPERATING_MODES (single source for help/error copy)', () => {
  it('is the complete, ordered set of modes', () => {
    // The /mode help text, the invalid-mode error, and parseOperatingMode all
    // derive from this list — so a new mode can never silently drop out of the
    // user-facing copy. yolo MUST be present (it was omitted from the strings).
    expect(OPERATING_MODES).toEqual(['plan', 'normal', 'auto', 'yolo'])
  })
})

describe('resolveInitialAutoApprove (startup mode↔autoApprove sync)', () => {
  // Bug: starting the REPL with `--mode yolo` set operatingModeState.mode=yolo
  // but left approveStateRef.autoApprove=false (it was env-only), so yolo was
  // dead at startup — same desync class as /mode/​/plan not mirroring before
  // setOperatingModeSynced. The mirror must agree with the initial mode.
  it('starting in yolo auto-approves even without the env var', () => {
    expect(resolveInitialAutoApprove('yolo', undefined)).toBe(true)
  })

  it('non-yolo startup modes do not auto-approve on their own', () => {
    expect(resolveInitialAutoApprove('plan', undefined)).toBe(false)
    expect(resolveInitialAutoApprove('normal', undefined)).toBe(false)
    expect(resolveInitialAutoApprove('auto', undefined)).toBe(false)
    expect(resolveInitialAutoApprove(undefined, undefined)).toBe(false)
  })

  it('still honors the supervised-run env escape hatch for non-yolo modes', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'yolo', 'YOLO', ' On ']) {
      expect(resolveInitialAutoApprove('normal', v)).toBe(true)
    }
    expect(resolveInitialAutoApprove('normal', '0')).toBe(false)
    expect(resolveInitialAutoApprove('normal', 'nope')).toBe(false)
  })
})

describe('cycleOperatingMode', () => {
  it('cycles normal → auto → plan → normal (Shift+Tab)', () => {
    expect(cycleOperatingMode('normal')).toBe('auto')
    expect(cycleOperatingMode('auto')).toBe('plan')
    expect(cycleOperatingMode('plan')).toBe('normal')
  })

  it('cycling out of yolo returns to normal (yolo needs explicit /yolo or /mode yolo)', () => {
    expect(cycleOperatingMode('yolo')).toBe('normal')
  })
})

describe('evaluateModeGate — wrong-case tool names (P2-12 safety sibling)', () => {
  it('plan mode refuses a wrong-case mutating bash just like the canonical name', () => {
    expect(evaluateModeGate('plan', 'bash', { command: 'rm -rf /tmp/x' })).not.toBeNull()
    expect(evaluateModeGate('plan', 'Bash', { command: 'rm -rf /tmp/x' })).not.toBeNull()
  })
  it('plan mode refuses a wrong-case Write', () => {
    expect(evaluateModeGate('plan', 'Write', { file_path: '/tmp/x', content: 'y' })).not.toBeNull()
  })
})
