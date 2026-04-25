import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  ansi,
  formatToolStart,
  formatToolEnd,
  formatError,
  formatIterations,
  truncateOutput,
  formatBanner,
  formatUsage,
  formatStopReason,
  Spinner,
} from '../../src/native/display.js'

describe('formatToolStart', () => {
  it('includes tool name', () => {
    const result = formatToolStart('bash', { command: 'ls' })
    expect(result).toContain('Bash')
  })

  it('shows command summary for bash', () => {
    const result = formatToolStart('bash', { command: 'npm run build' })
    expect(result).toContain('npm run build')
  })

  it('shows path for read', () => {
    const result = formatToolStart('read', { path: '/tmp/foo.ts' })
    expect(result).toContain('/tmp/foo.ts')
  })

  it('shows pattern for grep', () => {
    const result = formatToolStart('grep', { pattern: 'TODO', path: 'src/' })
    expect(result).toContain('/TODO/')
    expect(result).toContain('src/')
  })

  it('truncates long command strings', () => {
    const longCmd = 'a'.repeat(200)
    const result = formatToolStart('bash', { command: longCmd })
    expect(result).toContain('…')
  })
})

describe('formatToolEnd', () => {
  it('shows check mark for success', () => {
    const result = formatToolEnd('bash', 'ok', false, 150)
    expect(result).toContain('✓')
    expect(result).toContain('Bash')
    expect(result).toContain('150ms')
  })

  it('shows X for error', () => {
    const result = formatToolEnd('bash', 'fail', true, 50)
    expect(result).toContain('✗')
  })

  it('formats seconds for long durations', () => {
    const result = formatToolEnd('bash', 'ok', false, 2500)
    expect(result).toContain('2.5s')
  })
})

describe('formatError', () => {
  it('includes error message with color', () => {
    const result = formatError('connection refused')
    expect(result).toContain('connection refused')
    expect(result).toContain('✗')
  })
})

describe('formatIterations', () => {
  it('formats iteration count', () => {
    const result = formatIterations(3)
    expect(result).toContain('3 iterations')
    // Uses dim styling (ANSI dim or themed dim)
    expect(result).toContain('\x1b[')
  })
})

describe('truncateOutput', () => {
  it('returns short text unchanged', () => {
    const text = 'line1\nline2\nline3'
    expect(truncateOutput(text, 10)).toBe(text)
  })

  it('truncates long output with omission notice', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`)
    const text = lines.join('\n')
    const result = truncateOutput(text, 20)
    expect(result).toContain('omitted')
    expect(result.split('\n').length).toBeLessThan(50)
  })

  it('preserves head and tail lines', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `L${i}`)
    const text = lines.join('\n')
    const result = truncateOutput(text, 20)
    expect(result).toContain('L0')
    expect(result).toContain('L49')
  })
})

describe('Spinner', () => {
  it('can be started and stopped without error', async () => {
    const spinner = new Spinner()
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    spinner.start('loading')
    // Wait a small amount for a tick
    await new Promise((resolve) => setTimeout(resolve, 100))
    spinner.stop()

    stderrSpy.mockRestore()
  })

  it('stop is idempotent', () => {
    const spinner = new Spinner()
    spinner.stop()
    spinner.stop()
    // No error
  })

  it('start is idempotent', () => {
    const spinner = new Spinner()
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    spinner.start('loading')
    spinner.start('loading again') // should not create second interval
    spinner.stop()

    stderrSpy.mockRestore()
  })
})

describe('ansi', () => {
  it('has all expected color codes', () => {
    expect(ansi.reset).toBe('\x1b[0m')
    expect(ansi.bold).toBe('\x1b[1m')
    expect(ansi.red).toBe('\x1b[31m')
    expect(ansi.green).toBe('\x1b[32m')
    expect(ansi.yellow).toBe('\x1b[33m')
    expect(ansi.cyan).toBe('\x1b[36m')
    expect(ansi.gray).toBe('\x1b[90m')
  })
})

describe('formatBanner', () => {
  it('renders the pure welcome mark without runtime metadata', () => {
    const banner = formatBanner({
      version: '0.3.0',
      model: 'test-model',
      mode: 'native',
      sessionId: 'sess-123',
      cwd: '/tmp/test',
    })
    expect(banner).toContain('0.3.0')
    expect(banner).not.toContain('test-model')
    expect(banner).not.toContain('/tmp/test')
  })

  it('draws box corners', () => {
    const banner = formatBanner({
      version: '0.3.0',
      model: 'test-model',
      mode: 'native',
      sessionId: 'sess-123',
      cwd: '/tmp',
    })
    expect(banner).toContain('owlcoda')
    expect(banner).not.toContain('╭')
    expect(banner).not.toContain('╰')
  })

  it('includes OwlCoda braille owl art', () => {
    const banner = formatBanner({
      version: '0.3.0',
      model: 'test-model',
      mode: 'native',
      sessionId: 'sess-123',
      cwd: '/tmp',
    })
    // Banner uses Braille dot art for the owl, not an emoji
    expect(banner).toContain('owlcoda')
  })

  it('keeps recent sessions out of the compact welcome surface', () => {
    const banner = formatBanner({
      version: '0.3.0',
      model: 'test-model',
      mode: 'native',
      sessionId: 'sess-123',
      cwd: '/tmp',
      recentSessions: [
        { id: 'sess-abc-def-ghi-jkl', title: 'My Session', turns: 5, date: '2024-01-01' },
      ],
    })
    expect(banner).not.toContain('Recent activity')
    expect(banner).not.toContain('My Session')
  })

  it('omits recent sessions section when empty', () => {
    const banner = formatBanner({
      version: '0.3.0',
      model: 'test-model',
      mode: 'native',
      sessionId: 'sess-123',
      cwd: '/tmp',
    })
    expect(banner).not.toContain('No recent activity')
  })

  it('includes tips line', () => {
    const banner = formatBanner({
      version: '0.3.0',
      model: 'test-model',
      mode: 'native',
      sessionId: 'sess-123',
      cwd: '/tmp',
    })
    expect(banner).toContain('/help')
    expect(banner).toContain('@')
  })
})

describe('formatUsage', () => {
  it('shows input and output tokens', () => {
    const result = formatUsage(100, 250)
    expect(result).toContain('100')
    expect(result).toContain('250')
    expect(result).toContain('in')
    expect(result).toContain('out')
  })

  it('includes dim ANSI codes', () => {
    const result = formatUsage(10, 20)
    expect(result).toContain(ansi.dim)
    expect(result).toContain(ansi.reset)
  })
})

describe('formatStopReason', () => {
  it('returns empty for end_turn', () => {
    expect(formatStopReason('end_turn')).toBe('')
  })

  it('returns empty for tool_use', () => {
    expect(formatStopReason('tool_use')).toBe('')
  })

  it('returns empty for null', () => {
    expect(formatStopReason(null)).toBe('')
  })

  it('shows warning for max_tokens', () => {
    const result = formatStopReason('max_tokens')
    expect(result).toContain('Truncated')
    // Uses themed warning color (not necessarily basic \x1b[33m)
    expect(result).toContain('\x1b[')
  })

  it('shows dim text for stop_sequence', () => {
    const result = formatStopReason('stop_sequence')
    expect(result).toContain('stop sequence')
  })

  it('shows raw reason for unknown values', () => {
    const result = formatStopReason('custom_reason')
    expect(result).toContain('custom_reason')
  })
})
