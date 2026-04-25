/**
 * Terminal display utility tests — pure function verification.
 */
import { describe, it, expect } from 'vitest'
import {
  colorize,
  bold,
  dim,
  formatModelName,
  formatToolCall,
  formatToolResult,
  formatUsage,
  formatStopReason,
  formatPreflightResults,
  formatBanner,
  formatError,
  formatWarning,
  formatInfo,
} from '../src/frontend/display.js'

const RESET = '\x1b[0m'

describe('colorize', () => {
  it('wraps text with color and reset', () => {
    const result = colorize('hello', '\x1b[31m')
    expect(result).toBe('\x1b[31mhello\x1b[0m')
  })
})

describe('bold', () => {
  it('wraps text with bold', () => {
    expect(bold('test')).toContain('\x1b[1m')
    expect(bold('test')).toContain(RESET)
  })
})

describe('dim', () => {
  it('wraps text with dim', () => {
    expect(dim('test')).toContain('\x1b[2m')
    expect(dim('test')).toContain(RESET)
  })
})

describe('formatModelName', () => {
  it('applies cyan color', () => {
    const result = formatModelName('my-model')
    expect(result).toContain('my-model')
    expect(result).toContain('\x1b[36m')
  })
})

describe('formatToolCall', () => {
  it('includes tool name', () => {
    const result = formatToolCall('readFile', { path: '/tmp/x' })
    expect(result).toContain('readFile')
  })

  it('includes input JSON for small inputs', () => {
    const result = formatToolCall('test', { a: 1 })
    expect(result).toContain('"a"')
  })

  it('truncates large inputs', () => {
    const bigInput: Record<string, unknown> = {}
    for (let i = 0; i < 20; i++) bigInput[`key${i}`] = `value${i}`
    const result = formatToolCall('test', bigInput)
    expect(result).toContain('more lines')
  })
})

describe('formatToolResult', () => {
  it('shows success indicator for non-error', () => {
    const result = formatToolResult('myTool', false)
    expect(result).toContain('✓')
    expect(result).toContain('myTool')
  })

  it('shows failure indicator for error', () => {
    const result = formatToolResult('myTool', true)
    expect(result).toContain('✗')
    expect(result).toContain('failed')
  })
})

describe('formatUsage', () => {
  it('shows input and output token counts', () => {
    const result = formatUsage(100, 200)
    expect(result).toContain('100')
    expect(result).toContain('200')
  })
})

describe('formatStopReason', () => {
  it('returns empty for end_turn', () => {
    expect(formatStopReason('end_turn')).toBe('')
  })

  it('returns empty for tool_use', () => {
    expect(formatStopReason('tool_use')).toBe('')
  })

  it('returns truncated note for max_tokens', () => {
    expect(formatStopReason('max_tokens')).toContain('truncated')
  })

  it('returns stop sequence note', () => {
    expect(formatStopReason('stop_sequence')).toContain('stop sequence')
  })

  it('returns reason string for unknown reason', () => {
    expect(formatStopReason('custom_reason')).toContain('custom_reason')
  })
})

describe('formatPreflightResults', () => {
  it('shows healthy icon for healthy status', () => {
    const result = formatPreflightResults([{ name: 'Router', status: 'healthy', detail: 'ok' }])
    expect(result).toContain('✓')
    expect(result).toContain('Router')
  })

  it('shows warning icon for degraded status', () => {
    const result = formatPreflightResults([{ name: 'Model', status: 'degraded', detail: 'slow' }])
    expect(result).toContain('⚠')
  })

  it('shows error icon for missing status', () => {
    const result = formatPreflightResults([{ name: 'Config', status: 'missing', detail: 'not found' }])
    expect(result).toContain('✗')
  })

  it('includes header', () => {
    const result = formatPreflightResults([])
    expect(result).toContain('preflight')
  })
})

describe('formatBanner', () => {
  it('includes version', () => {
    const result = formatBanner('1.2.3', 'test-model', [])
    expect(result).toContain('1.2.3')
  })

  it('includes model name', () => {
    const result = formatBanner('1.0.0', 'my-model', [])
    expect(result).toContain('my-model')
  })

  it('includes capabilities when provided', () => {
    const result = formatBanner('1.0.0', 'm', ['cap1', 'cap2'])
    expect(result).toContain('cap1')
    expect(result).toContain('cap2')
  })

  it('includes help hint', () => {
    const result = formatBanner('1.0.0', 'm', [])
    expect(result).toContain('/help')
  })
})

describe('formatError', () => {
  it('includes error prefix', () => {
    expect(formatError('bad thing')).toContain('Error: bad thing')
  })
})

describe('formatWarning', () => {
  it('includes warning message', () => {
    expect(formatWarning('careful')).toContain('careful')
  })
})

describe('formatInfo', () => {
  it('dims the message', () => {
    const result = formatInfo('info text')
    expect(result).toContain('info text')
    expect(result).toContain('\x1b[2m')
  })
})
