import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  formatToolUseHeader, formatToolResult, formatToolResultBox, formatToolProgress,
  formatChangeBlockResult,
  formatPrompt, formatPromptDock, renderPromptDockFrame, formatUserMessage, formatAssistantHeader, formatThinking, formatSystemMessage,
  formatErrorMessage, formatErrorBox,
  formatTokenUsage, formatStopReason, formatIterations,
  formatKeyHint, formatRateLimitCountdown,
  renderStatusBar,
  renderComposerRail,
  PersistentStatusBar,
  ToolResultCollector,
  tryJsonFormatOutput,
} from '../../../src/native/tui/message.js'
import { stripAnsi } from '../../../src/native/tui/colors.js'

describe('formatToolUseHeader', () => {
  it('includes tool name', () => {
    const result = formatToolUseHeader('bash', { command: 'ls' })
    expect(result).toContain('Bash')
    expect(result).toContain('ls')
    // Summary should be rendered in parentheses for compact tool headers.
    expect(stripAnsi(result)).toContain('(ls)')
  })

  it('shows progress dot for tools', () => {
    const result = formatToolUseHeader('read', { path: '/tmp/f' })
    // Uses ⏺ (macOS) or ● progress indicator, not per-tool icons
    expect(result).toContain('Read')
  })

  it('shows progress dot for unknown tools', () => {
    const result = formatToolUseHeader('CustomTool', {})
    expect(result).toContain('CustomTool')
  })

  it('truncates long commands to the compact header budget', () => {
    const longCmd = 'x'.repeat(200)
    const result = formatToolUseHeader('bash', { command: longCmd })
    const plain = stripAnsi(result)
    // Should not contain the full 200-char command
    expect(plain.length).toBeLessThan(250)
  })

  it('truncates multi-line commands to 2 lines', () => {
    const multiLine = 'line1\nline2\nline3\nline4'
    const result = formatToolUseHeader('bash', { command: multiLine })
    const plain = stripAnsi(result)
    // Should not contain line3/line4
    expect(plain).not.toContain('line4')
  })
})

describe('formatToolResult', () => {
  it('shows checkmark for success with tree bracket', () => {
    const result = formatToolResult('bash', 'ok', false, 100)
    expect(result).toContain('✓')
    expect(result).toContain('100ms')
    expect(result).toContain('⎿')
  })

  it('shows X for error', () => {
    const result = formatToolResult('bash', 'fail', true, 50)
    expect(result).toContain('✗')
  })

  it('formats seconds for long durations', () => {
    const result = formatToolResult('read', '', false, 2500)
    expect(result).toContain('2.5s')
  })

  it('formats TodoWrite output as a compact plan block', () => {
    const output = [
      'Todo List:',
      '',
      '  ✓ Read design spec [completed]',
      '  ▶ Implementing panel renderer [in_progress]',
      '  ○ Run smoke tests [pending]',
      '',
      'Progress: 1/3',
    ].join('\n')
    const result = formatToolResult('TodoWrite', output, false, 400)
    const plain = stripAnsi(result)
    // New design's oc-todo block: bordered card with TODO head + count
    // ("1/3 done · 1 active") + per-state glyphs (✓ done, ▸ current, □ pending).
    expect(plain).toContain('Plan updated')
    expect(plain).toContain('TODO')
    expect(plain).toContain('1/3 done')
    expect(plain).toContain('1 active')
    expect(plain).toContain('Read design spec')
    expect(plain).toContain('Implementing panel renderer')
    expect(plain).toContain('Run smoke tests')
  })

  it('shows output lines for errors', () => {
    const result = formatToolResult('bash', 'Error: not found\nstacktrace', true, 100)
    expect(result).toContain('Error: not found')
  })

  it('truncates write output to 10 lines', () => {
    const longOutput = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n')
    const result = formatToolResult('write', longOutput, false, 100)
    const plain = stripAnsi(result)
    expect(plain).toContain('line0')
    expect(plain).toContain('line9')
    expect(plain).not.toContain('line10')
    expect(plain).toContain('+20 lines')
  })

  it('truncates bash output to 15 lines', () => {
    const longOutput = Array.from({ length: 25 }, (_, i) => `out${i}`).join('\n')
    const result = formatToolResult('bash', longOutput, false, 100)
    const plain = stripAnsi(result)
    expect(plain).toContain('out0')
    expect(plain).toContain('out14')
    expect(plain).not.toContain('out15')
    expect(plain).toContain('+10 lines')
  })
})

describe('formatToolResultBox', () => {
  it('renders in a box', () => {
    const result = formatToolResultBox('bash', 'output line', false, 200)
    expect(result).toContain('output line')
  })
})

describe('formatChangeBlockResult', () => {
  const bodyLines = ['     42   a', '     43 - b', '     43 + B', '     44   c']

  it('emits Update header with path and +N -M stats', () => {
    const result = formatChangeBlockResult({
      toolName: 'edit', action: 'update', path: 'src/foo.ts',
      added: 1, removed: 1, durationMs: 1234, bodyLines,
    })
    const plain = stripAnsi(result)
    expect(plain).toContain('Update src/foo.ts')
    expect(plain).toContain('+1')
    expect(plain).toContain('-1')
    expect(plain).toContain('(1.2s)')
    expect(plain).toContain('42   a')
    expect(plain).toContain('43 - b')
  })

  it('uses Create label for file-create actions', () => {
    const result = formatChangeBlockResult({
      toolName: 'write', action: 'create', path: '/tmp/new.ts',
      added: 3, removed: 0, durationMs: 40, bodyLines: ['     1 + hi'],
    })
    const plain = stripAnsi(result)
    expect(plain).toContain('Create')
    expect(plain).toContain('+3')
    expect(plain).not.toContain('-0')
  })

  it('uses Rewrite label for overwrite actions', () => {
    const result = formatChangeBlockResult({
      toolName: 'write', action: 'overwrite', path: 'src/a.ts',
      added: 2, removed: 5, durationMs: 80, bodyLines,
    })
    expect(stripAnsi(result)).toContain('Rewrite src/a.ts')
  })

  it('contains no box-drawing characters in header or body', () => {
    const result = formatChangeBlockResult({
      toolName: 'edit', action: 'update', path: 'src/foo.ts',
      added: 1, removed: 1, durationMs: 10, bodyLines,
    })
    expect(result).not.toMatch(/[╭╮╯╰┃┏┓┗┛]/)
  })
})

describe('tryJsonFormatOutput', () => {
  it('formats valid JSON objects', () => {
    const result = tryJsonFormatOutput('{"name":"Alice","age":30}')
    expect(result).toContain('"name": "Alice"')
    expect(result).toContain('\n')
  })

  it('formats valid JSON arrays', () => {
    const result = tryJsonFormatOutput('[1,2,3]')
    expect(result).toContain('[\n')
  })

  it('returns non-JSON strings unchanged', () => {
    const input = 'hello world\nthis is not json'
    expect(tryJsonFormatOutput(input)).toBe(input)
  })

  it('returns empty string unchanged', () => {
    expect(tryJsonFormatOutput('')).toBe('')
  })

  it('skips formatting for output exceeding 10K chars', () => {
    const bigJson = JSON.stringify({ data: 'x'.repeat(11000) })
    expect(tryJsonFormatOutput(bigJson)).toBe(bigJson)
  })

  it('formats bash tool results with JSON in formatToolResult', () => {
    const jsonOutput = '{"status":"ok","count":5}'
    const result = formatToolResult('bash', jsonOutput, false, 100)
    const plain = stripAnsi(result)
    expect(plain).toContain('"status": "ok"')
  })
})

describe('formatToolProgress', () => {
  it('shows Running with tree bracket', () => {
    const result = formatToolProgress()
    expect(stripAnsi(result)).toContain('⎿')
    expect(stripAnsi(result)).toContain('Running')
  })

  it('accepts custom message', () => {
    const result = formatToolProgress('Fetching…')
    expect(stripAnsi(result)).toContain('Fetching')
  })
})

describe('formatUserMessage', () => {
  it('shows user text with prompt', () => {
    const result = formatUserMessage('hello')
    expect(result).toContain('▎')
    expect(result).toContain('hello')
  })

  it('formatUserMessage prefixes every line of a multi-line input', () => {
    const out = formatUserMessage('line one\nline two\nline three')
    const lines = out.split('\n').filter(l => l.length > 0)
    // Expect all non-empty lines to contain the ▎ marker
    for (const line of lines) {
      expect(line).toContain('▎')
    }
  })

  it('formatUserMessage handles single-line input unchanged in structure', () => {
    const out = formatUserMessage('hello')
    expect(out).toContain('▎')
    expect(out).toContain('hello')
  })
})

describe('formatAssistantHeader', () => {
  it('shows owl emoji', () => {
    const result = formatAssistantHeader()
    expect(result).toContain('🦉')
  })
})

describe('formatSystemMessage', () => {
  it('shows the design system marker', () => {
    const result = formatSystemMessage('system ready')
    expect(stripAnsi(result)).toContain('—')
    expect(stripAnsi(result).replace(/\u2009/g, '').toLowerCase()).toContain('system ready')
  })
})

describe('formatErrorMessage', () => {
  it('shows error with X', () => {
    const result = formatErrorMessage('bad things')
    expect(result).toContain('✗')
    expect(result).toContain('bad things')
  })
})

describe('formatTokenUsage', () => {
  it('shows input and output tokens', () => {
    const result = formatTokenUsage(1500, 300)
    expect(stripAnsi(result)).toContain('1.5K')
    expect(stripAnsi(result)).toContain('300')
  })
})

describe('formatStopReason', () => {
  it('returns empty for end_turn', () => {
    expect(formatStopReason('end_turn')).toBe('')
  })

  it('returns empty for null', () => {
    expect(formatStopReason(null)).toBe('')
  })

  it('warns for max_tokens', () => {
    const result = formatStopReason('max_tokens')
    expect(result).toContain('Truncated')
  })
})

describe('formatIterations', () => {
  it('shows count', () => {
    const result = formatIterations(5)
    expect(result).toContain('5 iterations')
  })
})

describe('renderStatusBar', () => {
  it('shows model name', () => {
    const result = renderStatusBar({ model: 'test-model' })
    expect(result).toContain('test-model')
  })

  it('shows token budget with percentage', () => {
    const result = renderStatusBar({
      model: 'test',
      tokens: { input: 5000, output: 1000, max: 100000 },
    })
    const plain = stripAnsi(result)
    expect(plain).toContain('6%')
    expect(plain).toContain('6.0K')
  })

  it('shows approve status', () => {
    const auto = renderStatusBar({ model: 'm', approve: true })
    expect(auto).toContain('Auto')

    const ask = renderStatusBar({ model: 'm', approve: false })
    expect(ask).toContain('Ask')
  })

  it('shows cost when provided', () => {
    const result = renderStatusBar({ model: 'm', cost: 0.042 })
    expect(stripAnsi(result)).toContain('$0.042')
  })

  it('shows per-tool approved count', () => {
    const result = renderStatusBar({ model: 'm', approve: false, perToolApproved: 3 })
    expect(stripAnsi(result)).toContain('3 allowed')
  })

  it('shows duration when provided', () => {
    const result = renderStatusBar({ model: 'm', durationMs: 2345 })
    expect(stripAnsi(result)).toContain('2.3s')
  })
})

describe('formatPrompt', () => {
  it('renders message dock pipe by default', () => {
    const result = formatPrompt()
    expect(result).toContain('│')
    expect(result).not.toContain('\x1b[2m') // not dimmed
  })

  it('renders dimmed pipe when dimmed=true', () => {
    const result = formatPrompt({ dimmed: true })
    expect(result).toContain('│')
    expect(result).toContain('\x1b[2m') // dim SGR
  })

  it('renders ! for bash mode', () => {
    const result = formatPrompt({ mode: 'bash' })
    const plain = stripAnsi(result)
    expect(plain.trim()).toBe('!')
  })

  it('ends with a space for readline alignment', () => {
    expect(formatPrompt()).toMatch(/ $/)
  })
})

describe('formatPromptDock', () => {
  it('renders a message dock header', () => {
    const result = formatPromptDock()
    const plain = stripAnsi(result)
    expect(plain).toContain('Message')
    expect(plain).toContain('/ commands')
    expect(plain).toContain('╭')
    expect(plain).toContain('╮')
  })

  it('renders a shell dock header in bash mode', () => {
    const result = formatPromptDock({ mode: 'bash' })
    const plain = stripAnsi(result)
    expect(plain).toContain('Shell')
  })
})

describe('renderPromptDockFrame', () => {
  it('renders a complete single-line frame', () => {
    const frame = renderPromptDockFrame()
    const plainTop = stripAnsi(frame.top)
    const plainPrompt = stripAnsi(frame.promptLine)
    const plainBottom = stripAnsi(frame.bottom)
    expect(plainTop).toContain('Message')
    expect(plainPrompt).toContain('│')
    expect(plainBottom).toContain('╰')
    expect(frame.fillerLines).toHaveLength(0)
    expect(frame.bodyRows).toBe(1)
    expect(frame.height).toBe(3)
    expect(frame.cursorColumn).toBeGreaterThanOrEqual(3)
  })

  it('adds multiline filler rows with tilde placeholders', () => {
    const frame = renderPromptDockFrame({ multiline: true })
    expect(frame.fillerLines.length).toBeGreaterThan(0)
    expect(frame.bodyRows).toBe(4)
    expect(frame.height).toBe(6)
    expect(stripAnsi(frame.fillerLines[0]!)).toContain('~')
  })
})

describe('formatThinking', () => {
  it('returns ∴ Thinking… when active', () => {
    const result = formatThinking({ active: true })
    const plain = stripAnsi(result)
    expect(plain).toContain('▸')
    expect(plain).toContain('THINKING')
    expect(plain).toContain('● live')
  })

  it('returns empty when inactive and no text', () => {
    expect(formatThinking({ active: false })).toBe('')
    expect(formatThinking({})).toContain('THINKING')
  })

  it('shows expanded text when provided', () => {
    const result = formatThinking({ active: false, text: 'Let me consider...' })
    const plain = stripAnsi(result)
    expect(plain).toContain('▾')
    expect(plain).toContain('THOUGHT')
    expect(plain).toContain('Let me consider...')
  })
})

describe('PersistentStatusBar', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
  })

  it('creates with installed=false', () => {
    const bar = new PersistentStatusBar()
    expect(bar.isInstalled).toBe(false)
  })

  it('install preserves the current cursor instead of moving prompt to the bottom', () => {
    const bar = new PersistentStatusBar()
    bar.install()
    const output = stdoutSpy.mock.calls.map(call => String(call[0])).join('')
    expect(output).toContain('\x1b7')
    expect(output).toContain('\x1b[1;')
    expect(output).toContain('\x1b8')
    expect(output).not.toContain('\x1b[23;1H')
  })

  it('updates the reserved scroll region when prompt chrome needs more rows', () => {
    const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'rows')
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 24 })
    try {
      const bar = new PersistentStatusBar()
      bar.install()
      stdoutSpy.mockClear()
      bar.setReservedRows(4)
      const output = stdoutSpy.mock.calls.map(call => String(call[0])).join('')
      expect(output).toContain('\x1b[1;20r')
      expect(bar.getReservedRows()).toBe(4)
      expect(bar.getScrollBottomRow()).toBe(20)
    } finally {
      if (rowsDescriptor) {
        Object.defineProperty(process.stdout, 'rows', rowsDescriptor)
      }
    }
  })
})

describe('ToolResultCollector', () => {
  it('identifies collapsible tools', () => {
    const collector = new ToolResultCollector()
    expect(collector.isCollapsible('read')).toBe(true)
    expect(collector.isCollapsible('glob')).toBe(true)
    expect(collector.isCollapsible('grep')).toBe(true)
    expect(collector.isCollapsible('WebFetch')).toBe(true)
    expect(collector.isCollapsible('WebSearch')).toBe(true)
    expect(collector.isCollapsible('bash')).toBe(false)
    expect(collector.isCollapsible('write')).toBe(false)
    expect(collector.isCollapsible('edit')).toBe(false)
  })

  it('buffers collapsible tool results', () => {
    const collector = new ToolResultCollector()
    const result = collector.add({ name: 'read', input: {}, output: 'content', isError: false, durationMs: 50 })
    expect(result).toBeNull()
    expect(collector.pending).toBe(1)
  })

  it('flushes single item as individual result', () => {
    const collector = new ToolResultCollector()
    collector.add({ name: 'read', input: {}, output: 'file content', isError: false, durationMs: 50 })
    const output = collector.flush()
    const plain = stripAnsi(output)
    expect(plain).toContain('Read')
    expect(plain).toContain('50ms')
    expect(collector.pending).toBe(0)
  })

  it('flushes multiple items as collapsed summary', () => {
    const collector = new ToolResultCollector()
    collector.add({ name: 'read', input: {}, output: 'a', isError: false, durationMs: 30 })
    collector.add({ name: 'read', input: {}, output: 'b', isError: false, durationMs: 40 })
    collector.add({ name: 'grep', input: {}, output: 'c', isError: false, durationMs: 50 })
    const output = collector.flush()
    const plain = stripAnsi(output)
    expect(plain).toContain('read 2 files')
    expect(plain).toContain('searched 1 pattern')
    expect(plain).toContain('120ms')
  })

  it('verbose mode shows individual results', () => {
    const collector = new ToolResultCollector()
    collector.verbose = true
    collector.add({ name: 'read', input: {}, output: 'a', isError: false, durationMs: 30 })
    collector.add({ name: 'read', input: {}, output: 'b', isError: false, durationMs: 40 })
    const output = collector.flush()
    const plain = stripAnsi(output)
    // Should show each result separately (user-facing name is "Read")
    expect((plain.match(/Read/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('flush returns empty string when nothing buffered', () => {
    const collector = new ToolResultCollector()
    expect(collector.flush()).toBe('')
  })

  it('marks errors in collapsed summary', () => {
    const collector = new ToolResultCollector()
    collector.add({ name: 'read', input: {}, output: 'ok', isError: false, durationMs: 30 })
    collector.add({ name: 'read', input: {}, output: 'fail', isError: true, durationMs: 40 })
    const output = collector.flush()
    // Should use error icon ✗
    expect(output).toContain('✗')
  })
})

describe('formatKeyHint', () => {
  it('formats single hint', () => {
    const result = formatKeyHint([{ key: 'Enter', action: 'confirm' }])
    const plain = stripAnsi(result)
    expect(plain).toContain('Enter')
    expect(plain).toContain('confirm')
  })

  it('joins multiple hints with dot separator', () => {
    const result = formatKeyHint([
      { key: 'Enter', action: 'select' },
      { key: 'Esc', action: 'cancel' },
    ])
    const plain = stripAnsi(result)
    expect(plain).toContain('Enter')
    expect(plain).toContain('Esc')
    expect(plain).toContain('·')
  })
})

describe('formatRateLimitCountdown', () => {
  it('shows countdown when remaining > 0', () => {
    const result = formatRateLimitCountdown(5000, 10, 3)
    const plain = stripAnsi(result)
    expect(plain).toContain('5s')
    expect(plain).toContain('30%')
    expect(plain).toContain('⚠')
  })

  it('shows cleared message when remaining is 0', () => {
    const result = formatRateLimitCountdown(0, 10, 10)
    const plain = stripAnsi(result)
    expect(plain).toContain('cleared')
    expect(plain).toContain('100%')
  })
})

describe('renderComposerRail', () => {
  const base = {
    model: 'minimax-m27',
    mode: 'plan' as const,
    busy: false,
    queued: 0,
    contextTokens: 0,
    contextMax: 0,
    draftChars: 0,
    interruptRequested: false,
  }

  it('idle rail shows model + ready + send hint (no MODE cell)', () => {
    // Per the design rebuild, MODE is no longer painted as a cell because
    // it's a derived `busy ? act : plan` signal already carried by the
    // state pulse (●). The rail surfaces model, state, and the hint.
    const out = stripAnsi(renderComposerRail(base))
    expect(out).toContain('minimax-m27')
    expect(out).toContain('ready')
    expect(out).toContain('MODEL')
    expect(out).toContain('enter send')
    expect(out).not.toMatch(/MODE\s/)
  })

  it('busy rail shows thinking state and Ctrl+C hint', () => {
    const out = stripAnsi(renderComposerRail({ ...base, busy: true }))
    expect(out).toContain('thinking')
    expect(out).toContain('ctrl+c interrupt')
  })

  it('busy with queued shows count', () => {
    const out = stripAnsi(renderComposerRail({ ...base, busy: true, queued: 3 }))
    expect(out).toContain('busy · 3 queued')
    expect(out).toContain('QUEUED 3')
  })

  it('busy with active tool shows the tool state', () => {
    const out = stripAnsi(renderComposerRail({ ...base, busy: true, activeToolName: 'bash' }))
    expect(out).toContain('running bash')
  })

  it('approval rail shows approval state and permission keys', () => {
    const out = stripAnsi(renderComposerRail({ ...base, approval: true }))
    expect(out).toContain('approval')
    expect(out).toContain('y allow')
    expect(out).toContain('n deny')
  })

  it('draft char count appears when non-zero', () => {
    const out = stripAnsi(renderComposerRail({ ...base, draftChars: 47 }))
    expect(out).toContain('DRAFT 47')
  })

  it('can render stable draft presence for low-churn input paths', () => {
    const out = stripAnsi(renderComposerRail({ ...base, draftChars: 47, draftCellMode: 'presence' }))
    expect(out).toContain('DRAFT active')
    expect(out).not.toContain('DRAFT 47')
  })

  it('prunes secondary fields before overflowing narrow columns', () => {
    const out = stripAnsi(renderComposerRail({
      ...base,
      model: 'a-very-long-model-name-that-would-not-fit',
      contextTokens: 42000,
      contextMax: 200000,
      draftChars: 100,
      columns: 34,
    }))
    expect(out.length).toBeLessThanOrEqual(34)
    expect(out).toContain('ready')
  })
})
