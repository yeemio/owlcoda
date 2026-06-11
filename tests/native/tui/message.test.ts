import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  formatToolUseHeader, formatToolResult, formatToolProgress,
  formatChangeBlockResult,
  formatPrompt, formatPromptDock, renderPromptDockFrame, formatUserMessage, formatAssistantHeader, formatThinking, formatSystemMessage,
  formatErrorMessage, formatErrorBox,
  formatTokenUsage, formatStopReason, formatIterations,
  formatKeyHint, formatRateLimitCountdown,
  formatFooterOnlyToolEnd,
  formatFooterOnlyToolStart,
  renderStatusBar,
  renderComposerRail,
  PersistentStatusBar,
  ToolResultCollector,
  shouldRouteToolEndFooterOnly,
  shouldRouteToolStartFooterOnly,
  tryJsonFormatOutput,
} from '../../../src/native/tui/message.js'
import { stripAnsi, visibleWidth } from '../../../src/native/tui/colors.js'

function withStdoutColumns<T>(columns: number, fn: () => T): T {
  const desc = Object.getOwnPropertyDescriptor(process.stdout, 'columns')
  Object.defineProperty(process.stdout, 'columns', { configurable: true, value: columns })
  try {
    return fn()
  } finally {
    if (desc) Object.defineProperty(process.stdout, 'columns', desc)
    else delete (process.stdout as { columns?: number }).columns
  }
}

describe('formatToolUseHeader', () => {
  it('includes tool name', () => {
    const result = formatToolUseHeader('bash', { command: 'ls' })
    expect(result).toContain('Bash')
    expect(result).toContain('ls')
    // Summaries should read like a command row, not a JSON/debug tuple.
    expect(stripAnsi(result)).not.toContain('(ls)')
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

  it('summarizes TodoWrite input without leaking raw JSON', () => {
    const result = formatToolUseHeader('TodoWrite', {
      todos: [
        { content: 'Read chapter 1', activeForm: 'Reading chapter 1', status: 'completed' },
        { content: 'Write notes', activeForm: 'Writing notes', status: 'in_progress' },
        { content: 'Verify output', activeForm: 'Verifying output', status: 'pending' },
      ],
    })
    const plain = stripAnsi(result)
    expect(plain).toContain('TodoWrite')
    expect(plain).toContain('3 todos')
    expect(plain).toContain('1 done')
    expect(plain).toContain('1 active')
    expect(plain).toContain('1 pending')
    expect(plain).not.toContain('{')
    expect(plain).not.toContain('activeForm')
  })

  it('summarizes Brief input as user-facing text plus attachment count', () => {
    const result = formatToolUseHeader('Brief', {
      message: '已将反馈写入 /tmp/review.md，署名 mimo',
      attachments: ['/tmp/review.md'],
    })
    const plain = stripAnsi(result)
    expect(plain).toContain('Brief')
    expect(plain).toContain('已将反馈写入')
    expect(plain).toContain('1 attachment')
    expect(plain).not.toContain('{"message"')
    expect(plain).not.toContain('attachments":')
  })

  it('normalizes lower-case internal tool names before summarizing', () => {
    const result = formatToolUseHeader('brief', {
      message: '已将反馈写入 /tmp/review.md，署名 mimo',
      attachments: ['/tmp/review.md'],
    })
    const plain = stripAnsi(result)
    expect(plain).toContain('Brief')
    expect(plain).toContain('已将反馈写入')
    expect(plain).toContain('1 attachment')
    expect(plain).not.toContain('message:')
    expect(plain).not.toContain('{"message"')
  })

  it('summarizes task tools without raw object payloads', () => {
    const create = stripAnsi(formatToolUseHeader('TaskCreate', {
      subject: 'Apply polish edits',
      description: 'Fix awkward Chinese phrasing',
      steps: [
        { title: 'Fix wording', description: 'Apply six edits' },
        { title: 'Verify', description: 'Run grep checks' },
      ],
    }))
    expect(create).toContain('Apply polish edits')
    expect(create).toContain('2 steps')
    expect(create).not.toContain('{"subject"')

    const update = stripAnsi(formatToolUseHeader('TaskUpdate', {
      taskId: 'task-1',
      stepId: 'step-2',
      stepStatus: 'completed',
    }))
    expect(update).toContain('task-1')
    expect(update).toContain('step-2')
    expect(update).toContain('to completed')
    expect(update).not.toContain('{"taskId"')
  })

  it('uses compact key-value fallback for unknown tool inputs', () => {
    const result = stripAnsi(formatToolUseHeader('CustomTool', {
      message: 'hello world',
      values: ['a', 'b'],
    }))
    expect(result).toContain('message: hello world')
    expect(result).toContain('values: 2 items')
    expect(result).not.toContain('{"message"')
  })
})

describe('footer-only tool display routing', () => {
  it('routes successful DeliveryAudit display to footer-only', () => {
    expect(shouldRouteToolStartFooterOnly('DeliveryAudit')).toBe(true)
    expect(shouldRouteToolEndFooterOnly('DeliveryAudit', false)).toBe(true)
    expect(stripAnsi(formatFooterOnlyToolStart('DeliveryAudit'))).toBe('DeliveryAudit running…')
    expect(stripAnsi(formatFooterOnlyToolEnd('DeliveryAudit', 115))).toBe('DeliveryAudit completed (115ms)')
  })

  it('keeps DeliveryAudit errors and normal tools in the transcript path', () => {
    expect(shouldRouteToolEndFooterOnly('DeliveryAudit', true)).toBe(false)
    expect(shouldRouteToolStartFooterOnly('bash')).toBe(false)
    expect(shouldRouteToolEndFooterOnly('bash', false)).toBe(false)
  })

  it('routes successful task-state tool display to footer-only while keeping errors visible', () => {
    for (const tool of ['TaskCreate', 'TaskUpdate', 'TaskOutput']) {
      expect(shouldRouteToolStartFooterOnly(tool)).toBe(true)
      expect(shouldRouteToolEndFooterOnly(tool, false)).toBe(true)
      expect(shouldRouteToolEndFooterOnly(tool, true)).toBe(false)
    }
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

  it('collapses ok output to the head-3 default budget (chrome spec S1)', () => {
    const longOutput = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n')
    const result = formatToolResult('write', longOutput, false, 100)
    const plain = stripAnsi(result)
    expect(plain).toContain('line0')
    expect(plain).toContain('line2')
    expect(plain).not.toContain('line3\n')
    expect(plain).toContain('+27 lines')
  })

  it('collapses bash ok output to the head-5 budget (chrome spec S1)', () => {
    const longOutput = Array.from({ length: 25 }, (_, i) => `out${i}`).join('\n')
    const result = formatToolResult('bash', longOutput, false, 100)
    const plain = stripAnsi(result)
    expect(plain).toContain('out0')
    expect(plain).toContain('out4')
    expect(plain).not.toContain('out5\n')
    expect(plain).toContain('+20 lines')
  })

  it('hard-wraps long output lines so continuation rows keep the tool indent', () => {
    withStdoutColumns(48, () => {
      const result = formatToolResult(
        'Brief',
        '已将反馈写入 /Users/publicuser/AI/Article/02-读者反馈/mimo-6章评审.md, 署名 mimo',
        false,
        100,
      )
      const plainLines = stripAnsi(result).split('\n')
      expect(plainLines.length).toBeGreaterThan(2)
      for (const line of plainLines.slice(1)) {
        expect(line.startsWith('     ')).toBe(true)
        expect(visibleWidth(line)).toBeLessThanOrEqual(48)
      }
    })
  })
})

describe('unified error rendering (chrome spec S1 — box family retired)', () => {
  it('compact one-line form survives for fast validation errors (0ms + single short line)', () => {
    const result = formatToolResult('TaskCreate', 'steps must be a non-empty array.', true, 0)
    const plain = stripAnsi(result)
    expect(plain).not.toMatch(/\u2574/)
    expect(plain.split('\n').length).toBe(1)
    expect(plain).toContain('\u2717')
    expect(plain).toContain('TaskCreate')
    expect(plain).toContain('(0ms)')
    expect(plain).toContain('\u2014')
    expect(plain).toContain('steps must be a non-empty array.')
  })

  it('runtime failures use the same \u23bf shape as success — no \u2574 banner, no \u258e rail', () => {
    const result = stripAnsi(formatToolResult('bash', 'command failed: file not found', true, 150))
    expect(result).not.toMatch(/\u2574/)
    expect(result.split('\n')[0]).toContain('\u23bf')
    expect(result).toContain('\u2717')
    expect(result).toContain('command failed: file not found')
  })

  it('multi-line errors collapse to the tail behind the constant fold line', () => {
    const lines = Array.from({ length: 14 }, (_, i) => `diag ${i + 1}`).join('\n')
    const result = stripAnsi(formatToolResult('edit', lines, true, 80))
    expect(result).toContain('diag 14')
    expect(result).not.toContain('diag 1\n')
    expect(result).toMatch(/\u2026 \+4 lines/)
  })

  it('hard-wraps long output lines within the content width', () => {
    withStdoutColumns(52, () => {
      const result = formatToolResult(
        'Brief',
        '已将反馈写入 /Users/publicuser/AI/Article/02-读者反馈/mimo-6章评审.md, 署名 mimo',
        false,
        100,
      )
      const bodyLines = stripAnsi(result).split('\n').slice(1)
      expect(bodyLines.length).toBeGreaterThan(1)
      for (const line of bodyLines) {
        expect(line.startsWith('     ')).toBe(true)
        expect(visibleWidth(line)).toBeLessThanOrEqual(52)
      }
    })
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

  it('YOLO indicator appears in second cell when yolo is on', () => {
    const out = stripAnsi(renderComposerRail({ ...base, yolo: true }))
    expect(out).toContain('YOLO')
    // Should appear before MODEL — it's slotted at index 1, ahead of model at 2
    expect(out.indexOf('YOLO')).toBeLessThan(out.indexOf('MODEL'))
  })

  it('YOLO indicator hidden when yolo is off', () => {
    const out = stripAnsi(renderComposerRail({ ...base }))
    expect(out).not.toContain('YOLO')
  })

  it('YOLO indicator survives narrow-column pruning', () => {
    // The tail-drop loop drops cells from the right; YOLO at slot 1
    // (right after `state`) should outlive every secondary cell.
    const out = stripAnsi(renderComposerRail({
      ...base,
      yolo: true,
      contextTokens: 42000,
      contextMax: 200000,
      draftChars: 100,
      columns: 30,
    }))
    expect(out).toContain('YOLO')
  })
})
