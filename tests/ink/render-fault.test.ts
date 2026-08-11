import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderSync } from '../../src/ink/root.js'
import {
  createRenderFaultAdapter,
  type RenderFaultIncident,
} from '../../src/native/tui/chrome.js'

function makeAdapter(overrides: Partial<Parameters<typeof createRenderFaultAdapter>[0]> = {}) {
  const incidents: RenderFaultIncident[] = []
  const isolateFrameProducer = vi.fn()
  const cleanupTerminal = vi.fn()
  const requestRecovery = vi.fn()
  const notify = vi.fn()
  const adapter = createRenderFaultAdapter({
    getContext: () => ({ renderSequence: 7, frameSequence: 12 }),
    writeIncident: (incident) => {
      incidents.push(incident)
      return '/tmp/owlcoda-render-incident.json'
    },
    isolateFrameProducer,
    cleanupTerminal,
    requestRecovery,
    notify,
    ...overrides,
  })
  return {
    adapter,
    incidents,
    isolateFrameProducer,
    cleanupTerminal,
    requestRecovery,
    notify,
  }
}

describe('React reconciler render fault adapter', () => {
  it('records distinct structured truth for uncaught, caught, and recoverable faults', () => {
    const { adapter, incidents } = makeAdapter()

    adapter.onUncaughtError(new Error('uncaught boom'), { componentStack: ' at Crash' })
    adapter.onCaughtError(new Error('caught boom'), { componentStack: ' at Boundary' })
    adapter.onRecoverableError(new Error('recoverable boom'), { componentStack: ' at Recoverable' })

    expect(incidents.map((incident) => incident.faultKind)).toEqual([
      'uncaught',
      'caught',
      'recoverable',
    ])
    expect(incidents.map((incident) => incident.sequence)).toEqual([1, 2, 3])
    expect(incidents[0]).toMatchObject({
      frame: { renderSequence: 7, frameSequence: 12 },
      error: { name: 'Error', message: 'uncaught boom' },
    })
    expect(incidents[0]?.componentStack).toContain('Crash')
  })

  it('isolates the uncaught frame producer and cleans up the terminal', () => {
    const { adapter, incidents, isolateFrameProducer, cleanupTerminal, notify } = makeAdapter()

    expect(() => adapter.onUncaughtError(new Error('fatal render'), {})).not.toThrow()

    expect(isolateFrameProducer).toHaveBeenCalledTimes(1)
    expect(cleanupTerminal).toHaveBeenCalledTimes(1)
    expect(incidents[0]).toMatchObject({
      faultKind: 'uncaught',
      rendererState: 'isolated',
      recovery: 'terminal_cleanup',
      incidentPath: '/tmp/owlcoda-render-incident.json',
    })
    adapter.onUncaughtError(new Error('second fatal render'), {})
    expect(isolateFrameProducer).toHaveBeenCalledTimes(1)
    expect(cleanupTerminal).toHaveBeenCalledTimes(1)
    expect(incidents[1]).toMatchObject({
      rendererState: 'isolated',
      recovery: 'already_isolated',
    })
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('restart'))
  })

  it('bounds recoverable recovery to one controlled repaint', () => {
    const { adapter, incidents, requestRecovery } = makeAdapter()

    adapter.onRecoverableError(new Error('recoverable one'), {})
    adapter.onRecoverableError(new Error('recoverable two'), {})

    expect(requestRecovery).toHaveBeenCalledTimes(1)
    expect(incidents[0]?.recovery).toBe('repaint_scheduled')
    expect(incidents[1]?.recovery).toBe('repaint_suppressed_limit')
    expect(adapter.getState()).toMatchObject({ recoverableRecoveryCount: 1 })
  })

  it('contains handler failures and does not leak a hostile error value', () => {
    const secret = 'handler-secret-must-not-escape'
    const hostile = Object.create(null) as Record<string, unknown>
    Object.defineProperty(hostile, 'toString', {
      get() {
        throw new Error(secret)
      },
    })
    const records: RenderFaultIncident[] = []
    const { adapter } = makeAdapter({
      getContext: () => {
        throw new Error(secret)
      },
      writeIncident: (incident) => {
        records.push(incident)
        throw new Error(secret)
      },
      isolateFrameProducer: () => {
        throw new Error(secret)
      },
      cleanupTerminal: () => {
        throw new Error(secret)
      },
      notify: () => {
        throw new Error(secret)
      },
    })

    expect(() => adapter.onUncaughtError(hostile, {})).not.toThrow()
    expect(JSON.stringify(records)).not.toContain(secret)
    expect(records[0]?.error).toEqual({
      name: 'UnknownError',
      message: '[unavailable]',
      stack: null,
    })
  })

  it('wires a React root fault to an incident instead of silently continuing', () => {
    const home = mkdtempSync(join(tmpdir(), 'owlcoda-render-fault-wiring-'))
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream
    stdout.isTTY = false
    stdout.columns = 80
    stdout.rows = 24
    stdin.isTTY = false
    process.env['OWLCODA_HOME'] = home

    function ThrowingComponent(): React.ReactElement {
      throw new Error('uncaught wiring fault')
    }

    let instance: ReturnType<typeof renderSync> | undefined
    try {
      expect(() => {
        instance = renderSync(React.createElement(ThrowingComponent), {
          stdout,
          stdin,
          stderr: stdout,
          patchConsole: false,
          exitOnCtrlC: false,
        })
      }).not.toThrow()

      const files = readdirSync(join(home, 'render-incidents'))
      expect(files).toHaveLength(1)
      const payload = JSON.parse(readFileSync(join(home, 'render-incidents', files[0]!), 'utf8'))
      expect(payload).toMatchObject({
        faultKind: 'caught',
        rendererState: 'healthy',
        recovery: 'none',
      })
    } finally {
      instance?.unmount()
      instance?.cleanup()
      delete process.env['OWLCODA_HOME']
      rmSync(home, { recursive: true, force: true })
    }
  })
})
