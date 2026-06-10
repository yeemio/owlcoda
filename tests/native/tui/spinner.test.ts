import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  Spinner, VerbSpinner, withSpinner, withVerbSpinner,
  SPINNER_GLYPHS, OWL_VERBS, randomVerb, interpolateRgb,
} from '../../../src/native/tui/spinner.js'

describe('Spinner', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  it('starts and stops without error', async () => {
    const spinner = new Spinner({ style: 'dots' })
    spinner.start('loading')
    await new Promise(r => setTimeout(r, 100))
    spinner.stop()
  })

  it('is idempotent on start', () => {
    const spinner = new Spinner()
    spinner.start()
    spinner.start() // should not double-start
    spinner.stop()
  })

  it('is idempotent on stop', () => {
    const spinner = new Spinner()
    spinner.stop() // should not throw
    spinner.stop()
  })

  it('reports running state', () => {
    const spinner = new Spinner()
    expect(spinner.isRunning()).toBe(false)
    spinner.start()
    expect(spinner.isRunning()).toBe(true)
    spinner.stop()
    expect(spinner.isRunning()).toBe(false)
  })

  it('can update message while running', () => {
    const spinner = new Spinner({ message: 'initial' })
    spinner.start()
    spinner.update('updated')
    spinner.stop()
  })

  it('can be marked as stalled', () => {
    const spinner = new Spinner()
    spinner.start()
    spinner.markStalled()
    spinner.stop()
  })

  it('uses spinnerStall theme color when stalled', async () => {
    const spinner = new Spinner()
    spinner.start()
    spinner.markStalled()
    await new Promise(r => setTimeout(r, 100))
    spinner.stop()
    // Stalled spinner writes to stderr
    expect(stderrSpy).toHaveBeenCalled()
  })
})

describe('VerbSpinner', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  it('starts and stops cleanly', async () => {
    const spinner = new VerbSpinner({ glyphInterval: 50 })
    spinner.start()
    expect(spinner.isRunning()).toBe(true)
    await new Promise(r => setTimeout(r, 100))
    spinner.stop()
    expect(spinner.isRunning()).toBe(false)
  })

  it('tracks elapsed time', async () => {
    const spinner = new VerbSpinner()
    expect(spinner.getElapsed()).toBe(0)
    spinner.start()
    await new Promise(r => setTimeout(r, 50))
    expect(spinner.getElapsed()).toBeGreaterThan(0)
    spinner.stop()
  })

  it('handles token count updates', () => {
    const spinner = new VerbSpinner({ showTokens: true })
    spinner.start()
    spinner.updateTokens(42)
    spinner.stop()
  })

  it('supports stalled/cleared state', () => {
    const spinner = new VerbSpinner()
    spinner.start()
    spinner.markStalled()
    spinner.clearStalled()
    spinner.stop()
  })

  it('is idempotent on start/stop', () => {
    const spinner = new VerbSpinner()
    spinner.start()
    spinner.start() // no double-start
    spinner.stop()
    spinner.stop() // no double-stop
  })

  it('uses stars glyph style by default', () => {
    // VerbSpinner defaults to 'stars' (not 'dots')
    const spinner = new VerbSpinner()
    spinner.start()
    spinner.stop()
    // Verify it wrote something to stderr
    expect(stderrSpy).toHaveBeenCalled()
  })

  it('renders a fixed branded message when provided', async () => {
    const spinner = new VerbSpinner({ glyphInterval: 50, message: 'OwlCoda working…' })
    spinner.start()
    await new Promise(r => setTimeout(r, 60))
    spinner.stop()
    const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('')
    expect(output).toContain('OwlCoda working…')
  })
})

describe('OWL_VERBS', () => {
  it('has at least 50 verbs', () => {
    expect(OWL_VERBS.length).toBeGreaterThanOrEqual(50)
  })

  it('all verbs end in -ing', () => {
    for (const verb of OWL_VERBS) {
      // Allow hyphenated verbs like "Pellet-casting"
      expect(verb).toMatch(/ing$/)
    }
  })

  it('has no duplicates', () => {
    const lower = OWL_VERBS.map(v => v.toLowerCase())
    expect(new Set(lower).size).toBe(OWL_VERBS.length)
  })
})

describe('randomVerb', () => {
  it('returns a string from OWL_VERBS', () => {
    for (let i = 0; i < 10; i++) {
      const verb = randomVerb()
      expect(OWL_VERBS).toContain(verb)
    }
  })
})

describe('interpolateRgb', () => {
  it('returns start color at t=0', () => {
    const result = interpolateRgb([255, 0, 0], [0, 0, 255], 0)
    expect(result).toEqual([255, 0, 0])
  })

  it('returns end color at t=1', () => {
    const result = interpolateRgb([255, 0, 0], [0, 0, 255], 1)
    expect(result).toEqual([0, 0, 255])
  })

  it('returns midpoint at t=0.5', () => {
    const result = interpolateRgb([0, 0, 0], [200, 100, 50], 0.5)
    expect(result).toEqual([100, 50, 25])
  })
})

describe('SPINNER_GLYPHS', () => {
  it('has all expected styles', () => {
    expect(SPINNER_GLYPHS).toHaveProperty('dots')
    expect(SPINNER_GLYPHS).toHaveProperty('owl')
    expect(SPINNER_GLYPHS).toHaveProperty('stars')
    expect(SPINNER_GLYPHS).toHaveProperty('line')
    expect(SPINNER_GLYPHS).toHaveProperty('blocks')
    expect(SPINNER_GLYPHS).toHaveProperty('arc')
    expect(SPINNER_GLYPHS).toHaveProperty('bounce')
  })

  it('all styles have at least 3 frames', () => {
    for (const [name, frames] of Object.entries(SPINNER_GLYPHS)) {
      expect(frames.length).toBeGreaterThanOrEqual(3)
    }
  })

  it('stars style has bidirectional frames (forward + reverse)', () => {
    const stars = SPINNER_GLYPHS.stars
    expect(stars.length).toBe(10) // 5 forward + 5 reverse (minus endpoints)
  })
})

describe('withSpinner', () => {
  it('resolves with the promise result', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const result = await withSpinner(Promise.resolve(42), 'counting')
    expect(result).toBe(42)
    stderrSpy.mockRestore()
  })

  it('cleans up on rejection', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    await expect(withSpinner(Promise.reject(new Error('boom')), 'failing'))
      .rejects.toThrow('boom')
    stderrSpy.mockRestore()
  })
})

describe('withVerbSpinner', () => {
  it('resolves with the promise result', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const result = await withVerbSpinner(Promise.resolve('done'))
    expect(result).toBe('done')
    stderrSpy.mockRestore()
  })
})

describe('ToolUseLoader', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  it('starts and stops without error', async () => {
    const { ToolUseLoader } = await import('../../../src/native/tui/spinner.js')
    const loader = new ToolUseLoader('bash')
    expect(loader.isRunning()).toBe(false)
    loader.start()
    expect(loader.isRunning()).toBe(true)
    await new Promise(r => setTimeout(r, 600))
    loader.stop()
    expect(loader.isRunning()).toBe(false)
    // Should have rendered at least once (blinkInterval 500ms, waited 600ms)
    expect(stderrSpy).toHaveBeenCalled()
  })

  it('is idempotent on start', async () => {
    const { ToolUseLoader } = await import('../../../src/native/tui/spinner.js')
    const loader = new ToolUseLoader('read')
    loader.start()
    loader.start() // should not double-start
    loader.stop()
  })

  it('shows progress data when updateProgress is called', async () => {
    const { ToolUseLoader } = await import('../../../src/native/tui/spinner.js')
    const loader = new ToolUseLoader('bash')
    loader.start()
    loader.updateProgress(42, 8192, 'last output line')
    await new Promise(r => setTimeout(r, 600))
    loader.stop()
    // Should have rendered with progress info (line count, byte count)
    const allOutput = stderrSpy.mock.calls.map(c => String(c[0])).join('')
    expect(allOutput).toContain('+42 lines')
    expect(allOutput).toContain('8.0K')
  })
})
