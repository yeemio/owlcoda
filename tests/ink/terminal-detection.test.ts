import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isSynchronizedOutputSupported,
  usesLowChurnTerminalMode,
  usesSafeTerminalRepaintMode,
} from '../../src/ink/terminal.js'

const MEDIATED_ENV_KEYS = [
  'OWLCODA_LOW_CHURN_TERMINAL',
  'CMUX_BUNDLE_ID',
  'CMUX_PORT',
  'CMUX_WORKSPACE_ID',
  'ZELLIJ',
  'ZELLIJ_PANE',
  'ZELLIJ_SESSION_NAME',
  'STY',
  'TMUX',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'KITTY_WINDOW_ID',
  'WT_SESSION',
  'VTE_VERSION',
  'ZED_TERM',
  'ConEmuANSI',
  'ConEmuPID',
  'ConEmuTask',
  'TERM',
  'OWLCODA_RENDER_MODE',
  'OWLCODA_SAFE_RENDER',
  'OWLCODA_FORCE_UNSAFE_DIFF',
  'OWLCODA_DEBUG_LOG',
] as const

describe('usesLowChurnTerminalMode', () => {
  let originals: Record<string, string | undefined> = {}

  beforeEach(() => {
    originals = {}
    for (const key of MEDIATED_ENV_KEYS) {
      originals[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of MEDIATED_ENV_KEYS) {
      const prior = originals[key]
      if (prior === undefined) delete process.env[key]
      else process.env[key] = prior
    }
  })

  it('returns false when no mediator signal is set (the bare-terminal default)', () => {
    expect(usesLowChurnTerminalMode()).toBe(false)
  })

  it('respects an explicit OWLCODA_LOW_CHURN_TERMINAL=1 override (cmux 0.13.x escape hatch)', () => {
    // cmux 0.13.20 was observed running OwlCoda with only TERM=xterm-256color
    // visible — none of the CMUX_* vars propagated to the child process, so
    // auto-detection cannot engage. The user override is the canonical fix
    // for that scenario; this lock-down test ensures regressions to the
    // override parser show up immediately.
    process.env.OWLCODA_LOW_CHURN_TERMINAL = '1'
    expect(usesLowChurnTerminalMode()).toBe(true)

    process.env.OWLCODA_LOW_CHURN_TERMINAL = 'true'
    expect(usesLowChurnTerminalMode()).toBe(true)

    process.env.OWLCODA_LOW_CHURN_TERMINAL = 'YES'
    expect(usesLowChurnTerminalMode()).toBe(true)
  })

  it('respects an explicit OWLCODA_LOW_CHURN_TERMINAL=0 even when an auto-signal is present', () => {
    // The override wins both ways so users can A/B normal-vs-low-churn
    // rendering inside the same multiplexer session for diagnosis.
    process.env.CMUX_BUNDLE_ID = 'cmux.test'
    process.env.OWLCODA_LOW_CHURN_TERMINAL = '0'
    expect(usesLowChurnTerminalMode()).toBe(false)

    process.env.OWLCODA_LOW_CHURN_TERMINAL = 'no'
    expect(usesLowChurnTerminalMode()).toBe(false)
  })

  it('engages low-churn mode for cmux env signals when forwarded', () => {
    process.env.CMUX_BUNDLE_ID = 'cmux.test'
    expect(usesLowChurnTerminalMode()).toBe(true)
    delete process.env.CMUX_BUNDLE_ID

    process.env.CMUX_PORT = '8765'
    expect(usesLowChurnTerminalMode()).toBe(true)
    delete process.env.CMUX_PORT

    process.env.CMUX_WORKSPACE_ID = 'ws-1'
    expect(usesLowChurnTerminalMode()).toBe(true)
  })

  it('engages low-churn mode for zellij and screen mediators', () => {
    process.env.ZELLIJ = '0'
    expect(usesLowChurnTerminalMode()).toBe(true)
    delete process.env.ZELLIJ

    process.env.ZELLIJ_PANE = '12'
    expect(usesLowChurnTerminalMode()).toBe(true)
    delete process.env.ZELLIJ_PANE

    process.env.ZELLIJ_SESSION_NAME = 'main'
    expect(usesLowChurnTerminalMode()).toBe(true)
    delete process.env.ZELLIJ_SESSION_NAME

    // GNU screen sets STY to `${pid}.${socket}` for every shell inside it.
    process.env.STY = '12345.pts-0.host'
    expect(usesLowChurnTerminalMode()).toBe(true)
  })
})

describe('usesSafeTerminalRepaintMode', () => {
  let originals: Record<string, string | undefined> = {}

  beforeEach(() => {
    originals = {}
    for (const key of MEDIATED_ENV_KEYS) {
      originals[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of MEDIATED_ENV_KEYS) {
      const prior = originals[key]
      if (prior === undefined) delete process.env[key]
      else process.env[key] = prior
    }
  })

  it('defaults to safe full repaint for main-screen correctness', () => {
    // After safeFullRepaint became ED2-free and shared across every full
    // repaint path, it became the correctness default. Cell-diff remains
    // available only as an explicit performance/diagnostic opt-in because
    // cursor-forward skips can preserve stale cells after terminal drift.
    expect(usesSafeTerminalRepaintMode()).toBe(true)
  })

  it('accepts explicit opt-in to safe full repaint via OWLCODA_RENDER_MODE', () => {
    process.env.OWLCODA_RENDER_MODE = 'safe'
    expect(usesSafeTerminalRepaintMode()).toBe(true)

    process.env.OWLCODA_RENDER_MODE = 'full'
    expect(usesSafeTerminalRepaintMode()).toBe(true)

    process.env.OWLCODA_RENDER_MODE = 'full-repaint'
    expect(usesSafeTerminalRepaintMode()).toBe(true)
  })

  it('honors the legacy OWLCODA_SAFE_RENDER toggle', () => {
    process.env.OWLCODA_SAFE_RENDER = '1'
    expect(usesSafeTerminalRepaintMode()).toBe(true)

    process.env.OWLCODA_SAFE_RENDER = '0'
    expect(usesSafeTerminalRepaintMode()).toBe(false)
  })

  it('explicit cell-diff aliases stay false', () => {
    process.env.OWLCODA_RENDER_MODE = 'diff'
    expect(usesSafeTerminalRepaintMode()).toBe(false)

    process.env.OWLCODA_RENDER_MODE = 'cell-diff'
    expect(usesSafeTerminalRepaintMode()).toBe(false)
  })

  it('clamps cell-diff back to safe under tmux (mediated-terminal smear guard)', () => {
    // cell-diff's cursor-forward "skip unchanged cells" patches assume the
    // physical cursor sits where the virtual screen thinks it does. tmux's
    // mediated pane re-chunks the byte stream and breaks that, so the skips land
    // on the wrong column → row-head/row-tail smear (captured: `BRANCH main`
    // rendered as `BRANCHnmain`). safeFullRepaint re-anchors each row with
    // absolute CUP+EL and is immune, so we clamp diff→safe in mediated terminals.
    process.env.OWLCODA_RENDER_MODE = 'diff'
    process.env.TMUX = '/tmp/tmux-1000/default,1234,0'
    expect(usesSafeTerminalRepaintMode()).toBe(true)
  })

  it('clamps cell-diff under GNU screen, zellij, and a screen/tmux TERM too', () => {
    process.env.OWLCODA_RENDER_MODE = 'diff'

    process.env.STY = '12345.pts-0.host'
    expect(usesSafeTerminalRepaintMode()).toBe(true)
    delete process.env.STY

    process.env.ZELLIJ = '0'
    expect(usesSafeTerminalRepaintMode()).toBe(true)
    delete process.env.ZELLIJ

    process.env.TERM = 'screen-256color'
    expect(usesSafeTerminalRepaintMode()).toBe(true)
  })

  it('clamps the legacy OWLCODA_SAFE_RENDER=0 diff opt-in under tmux as well', () => {
    process.env.OWLCODA_SAFE_RENDER = '0'
    process.env.TMUX = '/tmp/tmux-1000/default,1234,0'
    expect(usesSafeTerminalRepaintMode()).toBe(true)
  })

  it('logs the actual diff opt-in source when clamping legacy OWLCODA_SAFE_RENDER=0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owlcoda-render-mode-'))
    process.env.OWLCODA_SAFE_RENDER = '0'
    process.env.TMUX = '/tmp/tmux-1000/default,1234,0'
    process.env.OWLCODA_DEBUG_LOG = join(dir, 'debug.log')

    // Reload the module so the once-only clamp log state is fresh for this
    // assertion regardless of test execution order.
    vi.resetModules()
    const { usesSafeTerminalRepaintMode: freshUsesSafeTerminalRepaintMode } =
      await import('../../src/ink/terminal.js')

    expect(freshUsesSafeTerminalRepaintMode()).toBe(true)
    const log = readFileSync(process.env.OWLCODA_DEBUG_LOG, 'utf8')
    expect(log).toContain('OWLCODA_SAFE_RENDER=0')
    expect(log).not.toContain('OWLCODA_RENDER_MODE=diff')
  })

  it('honors OWLCODA_FORCE_UNSAFE_DIFF=1 to exercise cell-diff in tmux on purpose', () => {
    // The guard must stay overridable so the mediated-terminal smear can be
    // reproduced deliberately (the capture that proved this bug used forced
    // cell-diff under tmux). Without this escape hatch the guard would block its
    // own repro.
    process.env.OWLCODA_RENDER_MODE = 'diff'
    process.env.TMUX = '/tmp/tmux-1000/default,1234,0'
    process.env.OWLCODA_FORCE_UNSAFE_DIFF = '1'
    expect(usesSafeTerminalRepaintMode()).toBe(false)
  })
})

describe('isSynchronizedOutputSupported', () => {
  let originals: Record<string, string | undefined> = {}

  beforeEach(() => {
    originals = {}
    for (const key of MEDIATED_ENV_KEYS) {
      originals[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of MEDIATED_ENV_KEYS) {
      const prior = originals[key]
      if (prior === undefined) delete process.env[key]
      else process.env[key] = prior
    }
  })

  it('returns false when low-churn mode is engaged so BSU/ESU is suppressed', () => {
    // BSU/ESU (DEC mode 2026 sync output) wraps every paint in
    // `\x1b[?2026h` … `\x1b[?2026l`. Mediated buffers (cmux/zellij/screen)
    // chunk the byte stream and break the atomicity that BSU/ESU
    // promises, which manifests as half-painted frames during the smear.
    // Engaging low-churn mode disables BSU/ESU at the writeDiff path so
    // the outer terminal never sees a torn paint.
    process.env.OWLCODA_LOW_CHURN_TERMINAL = '1'
    expect(isSynchronizedOutputSupported()).toBe(false)
  })

  it('returns false under tmux even when low-churn auto-signals are absent', () => {
    process.env.TMUX = '/tmp/tmux-1000/default,1234,0'
    expect(isSynchronizedOutputSupported()).toBe(false)
  })

  it('returns true for known modern terminals when no mediator is present', () => {
    process.env.TERM_PROGRAM = 'iTerm.app'
    process.env.TERM_PROGRAM_VERSION = '3.6.6'
    expect(isSynchronizedOutputSupported()).toBe(true)
  })
})
