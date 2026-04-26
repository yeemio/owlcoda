import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  applyTranscriptScrollDelta,
  buildPromptBufferRows,
  classifyResolvedInput,
  composeBufferedInput,
  countTranscriptLines,
  createSyntheticLineSuppression,
  decideFailedContinuationSubmitAction,
  detectBufferedInputSignals,
  detectInputSignals,
  composeAssistantChunk,
  formatContinuationRetryStatus,
  formatRepeatedContinuationRetryGuidance,
  formatResumeCommand,
  handleSlashCommand,
  isContinuationRetryInput,
  isRetryEligibleContinuationFailure,
  shouldDrainQueuedInputAfterTurn,
  shouldQueueSubmitBehindRunningTask,
  shouldScheduleRuntimeAutoRetry,
  parseApiError,
  scrubPseudoToolCall,
  shouldSuppressReadlineRefresh,
  shouldIgnoreSyntheticLine,
  shouldOpenSlashPickerOnKeypress,
  slashCompleter,
  splitTranscriptForScrollback,
  stripModifiedEnterArtifacts,
  buildInlineStatusLine,
  buildOcLoaderFrame,
  buildOcWorkingIndicatorLines,
  buildSlashPickerItems,
  SLASH_COMMANDS_REQUIRING_ARGS,
  estimateWrappedLineCount,
  buildScrollIndicatorBar,
  parseSgrWheelDelta,
  reconcileTranscriptScrollOffset,
  resolveOnboardingShortcut,
  selectVisibleTranscriptItems,
  selectVisibleTranscriptWindow,
  getTranscriptInteractionCapability,
  type AnchorTier,
  type ApproveState,
  type ThinkingState,
  type TranscriptItem,
} from '../../src/native/repl.js'
import { createConversation, addUserMessage } from '../../src/native/conversation.js'
import { ToolDispatcher } from '../../src/native/dispatch.js'
import { UsageTracker } from '../../src/native/usage.js'
import { ToolResultCollector } from '../../src/native/tui/message.js'
import {
  createReplRuntimeState,
  startReplTask,
  interruptReplTask,
  finishReplTask,
  resetReplToIdle,
  canWriteTaskOutput,
} from '../../src/native/repl-state.js'
import { fuzzyMatch } from '../../src/native/tui/picker.js'
import { InputEvent } from '../../src/ink/events/input-event.js'
import { INITIAL_STATE, parseMultipleKeypresses } from '../../src/ink/parse-keypress.js'

function makeConv(model = 'test-model') {
  return createConversation({ system: 'test', model })
}

describe('Slash Commands', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  let usage: UsageTracker

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    usage = new UsageTracker()
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('/help returns true and prints help text', async () => {
    const conv = makeConv()
    expect(await handleSlashCommand('/help', conv, usage)).toBe(true)
    expect(logSpy).toHaveBeenCalled()
    const output = logSpy.mock.calls[0]![0] as string
    expect(output).toContain('/model')
    expect(output).toContain('/compact')
    // Categorized help headers
    expect(output).toContain('Chat & Model:')
    expect(output).toContain('Session:')
    expect(output).toContain('Configuration:')
    expect(output).toContain('Diagnostics:')
    expect(output).toContain('Observability:')
    expect(output).toContain('Backends:')
  })

  it('/model without arg shows current model', async () => {
    const conv = makeConv('gpt-4')
    expect(await handleSlashCommand('/model', conv, usage)).toBe(true)
    // New format: "Current model: <model>" with ANSI coloring
    const output = logSpy.mock.calls.map((c: any[]) => String(c[0])).join('\n')
    expect(output).toContain('gpt-4')
  })

  it('/model with arg switches model', async () => {
    const conv = makeConv('old-model')
    expect(await handleSlashCommand('/model new-model', conv, usage)).toBe(true)
    expect(conv.model).toBe('new-model')
    // New format: "✓ Set model to: <model>" with ANSI coloring
    const output = logSpy.mock.calls.map((c: any[]) => String(c[0])).join('\n')
    expect(output).toContain('new-model')
  })

  it('/clear resets turns and usage', async () => {
    const conv = makeConv()
    addUserMessage(conv, 'hello')
    addUserMessage(conv, 'world')
    expect(conv.turns.length).toBe(2)

    expect(await handleSlashCommand('/clear', conv, usage)).toBe(true)
    expect(conv.turns.length).toBe(0)
  })

  it('/retry keeps explicit retry behavior intact', async () => {
    const conv = makeConv()
    addUserMessage(conv, 'hello')
    conv.turns.push({
      role: 'assistant',
      content: [{ type: 'text', text: 'partial answer' }],
      timestamp: Date.now(),
    })
    const emit = vi.fn()
    const rl = { emit } as unknown as import('node:readline').Interface

    expect(await handleSlashCommand('/retry', conv, usage, undefined, undefined, undefined, undefined, undefined, rl)).toBe(true)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(emit).toHaveBeenCalledWith('line', 'hello')
    expect(conv.turns).toHaveLength(0)
  })

  it('/compact keeps last N turns (default 6)', async () => {
    const conv = makeConv()
    for (let i = 0; i < 10; i++) {
      addUserMessage(conv, `msg${i}`)
    }
    expect(conv.turns.length).toBe(10)

    await handleSlashCommand('/compact', conv, usage)
    // 6 kept + 1 summary turn (LLM call skipped in test — no opts)
    expect(conv.turns.length).toBe(7)
    // First turn is the summary
    expect((conv.turns[0]!.content[0] as any).text).toContain('compacted')
  })

  it('/compact with explicit count', async () => {
    const conv = makeConv()
    for (let i = 0; i < 10; i++) {
      addUserMessage(conv, `msg${i}`)
    }

    await handleSlashCommand('/compact 3', conv, usage)
    // 3 kept + 1 summary turn
    expect(conv.turns.length).toBe(4)
    // First turn is summary, second turn has the kept message
    expect((conv.turns[0]!.content[0] as any).text).toContain('compacted')
    expect((conv.turns[1]!.content[0] as any).text).toContain('msg7')
  })

  it('/compact 0 removes all turns except summary', async () => {
    const conv = makeConv()
    addUserMessage(conv, 'hi')
    await handleSlashCommand('/compact 0', conv, usage)
    // Summary turn is inserted even when keepN=0
    expect(conv.turns.length).toBe(1)
    expect((conv.turns[0]!.content[0] as any).text).toContain('compacted')
  })

  it('/compact with invalid arg shows usage', async () => {
    const conv = makeConv()
    await handleSlashCommand('/compact abc', conv, usage)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'))
  })

  it('/compact nothing to do when already small', async () => {
    const conv = makeConv()
    addUserMessage(conv, 'hi')
    await handleSlashCommand('/compact 6', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('nothing to compact')
  })

  it('/compact on empty conversation', async () => {
    const conv = makeConv()
    await handleSlashCommand('/compact', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('empty')
  })

  it('/init creates OWLCODA.md', async () => {
    const origCwd = process.cwd()
    const tmpDir = require('os').tmpdir()
    const testDir = require('path').join(tmpDir, `owlcoda-test-init-${Date.now()}`)
    require('fs').mkdirSync(testDir, { recursive: true })
    process.chdir(testDir)
    try {
      const conv = makeConv()
      await handleSlashCommand('/init', conv, usage)
      const output = logSpy.mock.calls.map(c => c[0]).join('\n')
      expect(output).toContain('Created')
      expect(output).toContain('OWLCODA.md')
      expect(require('fs').existsSync(require('path').join(testDir, 'OWLCODA.md'))).toBe(true)
      const content = require('fs').readFileSync(require('path').join(testDir, 'OWLCODA.md'), 'utf8')
      expect(content).toContain('guidance')
    } finally {
      process.chdir(origCwd)
      require('fs').rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('/init warns if OWLCODA.md already exists', async () => {
    const origCwd = process.cwd()
    const tmpDir = require('os').tmpdir()
    const testDir = require('path').join(tmpDir, `owlcoda-test-init3-${Date.now()}`)
    require('fs').mkdirSync(testDir, { recursive: true })
    require('fs').writeFileSync(require('path').join(testDir, 'OWLCODA.md'), '# existing owlcoda')
    process.chdir(testDir)
    try {
      const conv = makeConv()
      await handleSlashCommand('/init', conv, usage)
      const output = logSpy.mock.calls.map(c => c[0]).join('\n')
      expect(output).toContain('already exists')
    } finally {
      process.chdir(origCwd)
      require('fs').rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('/diff runs without error', async () => {
    const conv = makeConv()
    // Should not throw even outside git repo
    await handleSlashCommand('/diff', conv, usage)
    expect(logSpy).toHaveBeenCalled()
  }, 15_000)

  it('/turns shows turn count', async () => {
    const conv = makeConv()
    addUserMessage(conv, 'hello')
    await handleSlashCommand('/turns', conv, usage)
    expect(logSpy).toHaveBeenCalledWith('  Turns: 1 (👤 1 · 🤖 0)')
  })

  it('/cost shows usage info', async () => {
    const conv = makeConv()
    await handleSlashCommand('/cost', conv, usage)
    expect(logSpy).toHaveBeenCalled()
  })

  it('unknown command returns true with error', async () => {
    const conv = makeConv()
    expect(await handleSlashCommand('/unknown', conv, usage)).toBe(true)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown command'))
  })

  // ─── Round 32: new command tests ──────────────────────

  it('/status shows session info', async () => {
    const conv = makeConv('test-model')
    addUserMessage(conv, 'hi')
    await handleSlashCommand('/status', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('test-model')
    expect(output).toContain(conv.id)
    expect(output).toContain('Trace')
  })

  it('/config shows runtime config', async () => {
    const conv = makeConv('test-model')
    await handleSlashCommand('/config', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('Runtime Config')
    expect(output).toContain('test-model')
    expect(output).toContain('native')
  })

  it('/capabilities lists all capabilities', async () => {
    const conv = makeConv()
    await handleSlashCommand('/capabilities', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('Capabilities')
    expect(output).toContain('supported')
  })

  it('/capabilities includes honest transcript wheel label', async () => {
    const conv = makeConv()
    await handleSlashCommand('/capabilities', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('Wheel / trackpad transcript scroll')
    expect(output).toContain('tmux')
  })

  it('/trace toggles trace state', async () => {
    const conv = makeConv()
    const { isTraceEnabled, setTraceEnabled } = await import('../../src/trace.js')
    setTraceEnabled(false)
    await handleSlashCommand('/trace on', conv, usage)
    expect(isTraceEnabled()).toBe(true)
    await handleSlashCommand('/trace off', conv, usage)
    expect(isTraceEnabled()).toBe(false)
    // Toggle
    await handleSlashCommand('/trace', conv, usage)
    expect(isTraceEnabled()).toBe(true)
    setTraceEnabled(false) // cleanup
  })

  it('/doctor runs diagnostics', async () => {
    const conv = makeConv()
    await handleSlashCommand('/doctor', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('Doctor')
    expect(output).toContain('Active model')
    expect(output).toContain('Environment')
    expect(output).toContain('Node.js')
    expect(output).toContain('Transcript Interaction')
  })

  // ─── Round 33: session management command tests ───────

  it('/session shows current session info', async () => {
    const conv = makeConv('test-model')
    addUserMessage(conv, 'hello')
    await handleSlashCommand('/session', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('Current session')
    expect(output).toContain(conv.id)
    expect(output).toContain('test-model')
  })

  it('/history shows conversation turns', async () => {
    const conv = makeConv()
    addUserMessage(conv, 'first message')
    addUserMessage(conv, 'second message')
    await handleSlashCommand('/history', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('History')
    expect(output).toContain('first message')
    expect(output).toContain('second message')
  })

  it('/history N limits output', async () => {
    const conv = makeConv()
    for (let i = 0; i < 10; i++) addUserMessage(conv, `msg${i}`)
    await handleSlashCommand('/history 3', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('last 3 of 10')
  })

  it('/history on empty conversation', async () => {
    const conv = makeConv()
    await handleSlashCommand('/history', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('No messages')
  })

  it('/export json creates file', async () => {
    const conv = makeConv()
    addUserMessage(conv, 'test export')
    // Redirect to a temp dir
    const origCwd = process.cwd()
    const os = await import('node:os')
    const fs = await import('node:fs')
    const tmpDir = fs.mkdtempSync(os.tmpdir() + '/owlcoda-test-')
    process.chdir(tmpDir)
    try {
      await handleSlashCommand('/export json', conv, usage)
      const output = logSpy.mock.calls.map(c => c[0]).join('\n')
      expect(output).toContain('Exported to')
      // Verify file exists
      const files = fs.readdirSync(tmpDir)
      const jsonFile = files.find(f => f.endsWith('.json'))
      expect(jsonFile).toBeDefined()
      const content = JSON.parse(fs.readFileSync(fs.realpathSync(tmpDir + '/' + jsonFile!), 'utf-8'))
      expect(content.model).toBe('test-model')
      expect(content.messages.length).toBe(1)
    } finally {
      process.chdir(origCwd)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('/export markdown creates file', async () => {
    const conv = makeConv()
    addUserMessage(conv, 'hello markdown')
    const origCwd = process.cwd()
    const os = await import('node:os')
    const fs = await import('node:fs')
    const tmpDir = fs.mkdtempSync(os.tmpdir() + '/owlcoda-test-')
    process.chdir(tmpDir)
    try {
      await handleSlashCommand('/export markdown', conv, usage)
      const files = fs.readdirSync(tmpDir)
      const mdFile = files.find(f => f.endsWith('.md'))
      expect(mdFile).toBeDefined()
      const content = fs.readFileSync(tmpDir + '/' + mdFile!, 'utf-8')
      expect(content).toContain('OwlCoda Conversation Export')
      expect(content).toContain('hello markdown')
    } finally {
      process.chdir(origCwd)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // ─── Round 34: observability command tests ────────────

  it('/dashboard shows metrics overview', async () => {
    const conv = makeConv()
    await handleSlashCommand('/dashboard', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('Dashboard')
    expect(output).toContain('Tokens')
  })

  it('/audit shows empty message when no entries', async () => {
    const conv = makeConv()
    await handleSlashCommand('/audit', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toMatch(/audit|No audit/i)
  })

  it('/health shows circuit breaker status or empty', async () => {
    const conv = makeConv()
    await handleSlashCommand('/health', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toMatch(/Health|circuit|No circuit/i)
  })

  it('/ratelimit shows rate limit status or empty', async () => {
    const conv = makeConv()
    await handleSlashCommand('/ratelimit', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toMatch(/Rate|No rate/i)
  })

  it('/slo shows error budget or empty', async () => {
    const conv = makeConv()
    await handleSlashCommand('/slo', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toMatch(/Error Budget|No request/i)
  })

  it('/traces shows traces or empty', async () => {
    const conv = makeConv()
    await handleSlashCommand('/traces', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toMatch(/Traces|No request/i)
  })

  it('/perf shows performance or empty', async () => {
    const conv = makeConv()
    await handleSlashCommand('/perf', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toMatch(/perf|No perf/i)
  })

  it('/metrics outputs prometheus format', async () => {
    const conv = makeConv()
    await handleSlashCommand('/metrics', conv, usage)
    expect(logSpy).toHaveBeenCalled()
  })

  // ─── Round 35: backend + model management tests ────────

  it('/backends discovers backends or shows empty', async () => {
    const conv = makeConv()
    await handleSlashCommand('/backends', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toMatch(/Backend|No local/i)
  })

  it('/recommend shows recommendation or error', async () => {
    const conv = makeConv()
    await handleSlashCommand('/recommend general', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toMatch(/recommend|config|intent/i)
  })

  it('/recommend rejects invalid intent', async () => {
    const conv = makeConv()
    await handleSlashCommand('/recommend banana', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toMatch(/Invalid intent/)
  })

  it('/warmup warms up or shows no models', async () => {
    const conv = makeConv()
    await handleSlashCommand('/warmup', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toMatch(/warm|No models|config/i)
  }, 15_000)

  it('/plugins shows empty or lists plugins', async () => {
    const conv = makeConv()
    await handleSlashCommand('/plugins', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toMatch(/plugin|No plugin/i)
  })

  // ─── Round 36: tool approval tests ─────────────────────

  it('/approve toggles auto-approve state', async () => {
    const conv = makeConv()
    const state: ApproveState = { autoApprove: true }
    await handleSlashCommand('/approve off', conv, usage, undefined, state)
    expect(state.autoApprove).toBe(false)
    const output1 = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output1).toContain('OFF')

    logSpy.mockClear()
    await handleSlashCommand('/approve on', conv, usage, undefined, state)
    expect(state.autoApprove).toBe(true)
    const output2 = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output2).toContain('ON')
  })

  it('/approve without arg toggles', async () => {
    const conv = makeConv()
    const state: ApproveState = { autoApprove: true }
    await handleSlashCommand('/approve', conv, usage, undefined, state)
    expect(state.autoApprove).toBe(false)
    await handleSlashCommand('/approve', conv, usage, undefined, state)
    expect(state.autoApprove).toBe(true)
  })

  it('/approve shows fallback when no state available', async () => {
    const conv = makeConv()
    await handleSlashCommand('/approve', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('not available')
  })

  // ─── Round 37: branch, tag, compress tests ─────────────

  it('/branch attempts to branch session', async () => {
    const conv = makeConv()
    await handleSlashCommand('/branch test-branch', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toMatch(/branch|Cannot/i)
  })

  it('/branches lists branches or shows empty', async () => {
    const conv = makeConv()
    await handleSlashCommand('/branches', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toMatch(/branch|No branch|Cannot/i)
  })

  it('/tag shows usage without subcommand', async () => {
    const conv = makeConv()
    await handleSlashCommand('/tag', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('Usage')
  })

  it('/tag list shows tags or no tags', async () => {
    const conv = makeConv()
    await handleSlashCommand('/tag list', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toMatch(/tag|No tag/i)
  })

  it('/compress attempts compression', async () => {
    const conv = makeConv()
    await handleSlashCommand('/compress --trim 5', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toMatch(/compress|failed/i)
  })
})

describe('onboarding numeric shortcuts', () => {
  it('maps first-screen numbers to local actions instead of model prompts', () => {
    expect(resolveOnboardingShortcut('01')).toEqual({
      kind: 'hint',
      message: 'Ask anything: type a request, or use /help for commands.',
    })
    expect(resolveOnboardingShortcut('02')).toEqual({ kind: 'slash', command: '/help' })
    expect(resolveOnboardingShortcut('03')).toEqual({ kind: 'draft', value: '@' })
    expect(resolveOnboardingShortcut('04')).toEqual({ kind: 'slash', command: '/model' })
    expect(resolveOnboardingShortcut('05')).toEqual({ kind: 'slash', command: '/settings' })
    expect(resolveOnboardingShortcut('2')).toBeNull()
    expect(resolveOnboardingShortcut('hello')).toBeNull()
  })
})

describe('slashCompleter', () => {
  it('returns matching commands for partial input', () => {
    const [hits, line] = slashCompleter('/he')
    expect(line).toBe('/he')
    expect(hits).toContain('/help')
  })

  it('returns all commands when prefix has no match', () => {
    const [hits] = slashCompleter('/zzz')
    expect(hits.length).toBeGreaterThan(5)
  })

  it('returns all commands for bare slash to support picker discovery', () => {
    const [hits, token] = slashCompleter('/')
    expect(token).toBe('/')
    expect(hits).toContain('/help')
    expect(hits).toContain('/model')
  })

  it('returns empty for non-slash input', () => {
    const [hits] = slashCompleter('hello')
    expect(hits).toEqual([])
  })

  it('returns exact match for full command', () => {
    const [hits] = slashCompleter('/quit')
    expect(hits).toContain('/quit')
    expect(hits.length).toBe(1)
  })

  it('matches /co prefix to /compact, /cost, and /config and /capabilities', () => {
    const [hits] = slashCompleter('/co')
    expect(hits).toContain('/compact')
    expect(hits).toContain('/cost')
    expect(hits).toContain('/config')
  })

  it('matches /login in command list', () => {
    const [hits] = slashCompleter('/log')
    expect(hits).toContain('/login')
  })

  it('matches /s prefix to /save, /sessions, and /status', () => {
    const [hits] = slashCompleter('/s')
    expect(hits).toContain('/save')
    expect(hits).toContain('/sessions')
    expect(hits).toContain('/status')
  })

  it('matches /tr to /trace', () => {
    const [hits] = slashCompleter('/tr')
    expect(hits).toContain('/trace')
  })

  it('matches /re to /resume', () => {
    const [hits] = slashCompleter('/re')
    expect(hits).toContain('/resume')
  })

  it('matches /hi to /history', () => {
    const [hits] = slashCompleter('/hi')
    expect(hits).toContain('/history')
  })

  it('matches /ex to /exit and /export', () => {
    const [hits] = slashCompleter('/ex')
    expect(hits).toContain('/exit')
    expect(hits).toContain('/export')
  })

  it('matches /da to /dashboard', () => {
    const [hits] = slashCompleter('/da')
    expect(hits).toContain('/dashboard')
  })

  it('matches /au to /audit', () => {
    const [hits] = slashCompleter('/au')
    expect(hits).toContain('/audit')
  })

  it('matches /me to /metrics', () => {
    const [hits] = slashCompleter('/me')
    expect(hits).toContain('/metrics')
  })

  it('matches /ba to /backends', () => {
    const [hits] = slashCompleter('/ba')
    expect(hits).toContain('/backends')
  })

  it('matches /pl to /plugins', () => {
    const [hits] = slashCompleter('/pl')
    expect(hits).toContain('/plugins')
  })

  it('matches /wa to /warmup', () => {
    const [hits] = slashCompleter('/wa')
    expect(hits).toContain('/warmup')
  })

  it('matches /ap to /approve', () => {
    const [hits] = slashCompleter('/ap')
    expect(hits).toContain('/approve')
  })

  it('matches /br to /branch and /branches', () => {
    const [hits] = slashCompleter('/br')
    expect(hits).toContain('/branch')
    expect(hits).toContain('/branches')
  })

  it('matches /ta to /tag', () => {
    const [hits] = slashCompleter('/ta')
    expect(hits).toContain('/tag')
  })

  it('matches /com to /compact and /compress', () => {
    const [hits] = slashCompleter('/com')
    expect(hits).toContain('/compact')
    expect(hits).toContain('/compress')
  })

  it('matches /reset- to /reset-circuits and /reset-budgets', () => {
    const [hits] = slashCompleter('/reset-')
    expect(hits).toContain('/reset-circuits')
    expect(hits).toContain('/reset-budgets')
  })

  it('matches /ed to /editor', () => {
    const [hits] = slashCompleter('/ed')
    expect(hits).toContain('/editor')
  })
})

// ─── Round 41: UX hardening tests ──────────────────────────

describe('parseApiError', () => {
  it('extracts message from JSON API error', () => {
    const raw = 'API error 529: {"error":{"message":"No models available","type":"overloaded"}}'
    const result = parseApiError(raw)
    expect(result).toContain('Backend overloaded')
    expect(result).toContain('No models available')
  })

  it('uses friendly name for known status codes', () => {
    const raw = 'API error 429: {"error":{"message":"Too many requests"}}'
    expect(parseApiError(raw)).toContain('Rate limited')
    expect(parseApiError(raw)).toContain('Too many requests')
  })

  it('handles non-JSON API error body', () => {
    const raw = 'API error 500: Internal Server Error'
    const result = parseApiError(raw)
    expect(result).toContain('Internal server error')
    expect(result).toContain('Internal Server Error')
  })

  it('truncates long raw error messages', () => {
    const raw = 'A'.repeat(300)
    const result = parseApiError(raw)
    expect(result.length).toBeLessThan(210)
    expect(result).toContain('…')
  })

  it('handles API error with top-level message field', () => {
    const raw = 'API error 503: {"message":"Service temporarily unavailable"}'
    const result = parseApiError(raw)
    expect(result).toContain('Service unavailable')
    expect(result).toContain('Service temporarily unavailable')
  })

  it('returns short non-API errors as-is', () => {
    const raw = 'Something went wrong'
    expect(parseApiError(raw)).toBe('Something went wrong')
  })

  it('handles unknown status codes gracefully', () => {
    const raw = 'API error 418: {"error":{"message":"I am a teapot"}}'
    const result = parseApiError(raw)
    expect(result).toContain('HTTP 418')
    expect(result).toContain('I am a teapot')
  })

  it('prefers structured provider diagnostics when available', () => {
    const raw = 'API error 504: {"type":"error","error":{"message":"kimi-code request failed: timeout after 60s","diagnostic":{"provider":"kimi","model":"kimi-code","kind":"timeout","message":"kimi-code request failed: timeout after 60s","status":504,"requestId":"req-timeout","retryable":true,"detail":"timeout after 60s"}}}'
    const result = parseApiError(raw)
    expect(result).toContain('kimi-code request failed: timeout after 60s')
    expect(result).toContain('req-timeout')
  })

  it('recognizes ETIMEDOUT as timeout error', () => {
    const result = parseApiError('fetch failed: ETIMEDOUT')
    expect(result).toContain('timed out')
  })

  it('recognizes SSL certificate errors', () => {
    expect(parseApiError('UNABLE_TO_VERIFY_LEAF_SIGNATURE')).toContain('SSL certificate verification failed')
    expect(parseApiError('CERT_HAS_EXPIRED')).toContain('SSL certificate has expired')
    expect(parseApiError('SELF_SIGNED_CERT_IN_CHAIN')).toContain('Self-signed certificate')
    expect(parseApiError('ERR_TLS_CERT_ALTNAME_INVALID')).toContain('hostname mismatch')
  })

  it('recognizes ECONNREFUSED as connection error', () => {
    const result = parseApiError('fetch failed: ECONNREFUSED 127.0.0.1:8019')
    expect(result).toContain('Unable to connect')
  })
})

describe('failed continuation submit handling', () => {
  const continuationFailure = {
    kind: 'pre_first_token_stream_close' as const,
    phase: 'continuation' as const,
    message: 'kimi-code continuation failed: stream closed before first token',
    retryable: true,
  }

  const toolContinuationFailure = {
    kind: 'pre_first_token_stream_close' as const,
    phase: 'tool_continuation' as const,
    message: 'Tool completed, but model continuation failed before first token',
    retryable: true,
  }

  // The common real-world kimi-code failure: user's FIRST message, stream
  // closed before any assistant output. Earlier builds gated retry
  // eligibility on phase ∈ {continuation, tool_continuation}, so this
  // ubiquitous case fell through and the user's "继续" was written as a
  // new user turn instead of triggering a retry. The gate is now dropped.
  const requestPhaseFailure = {
    kind: 'pre_first_token_stream_close' as const,
    phase: 'request' as const,
    message: 'kimi-code request failed: stream closed before first token',
    retryable: true,
  }

  it('treats eligible failure plus short continuation input as retry continuation', () => {
    expect(isRetryEligibleContinuationFailure(continuationFailure)).toBe(true)
    expect(isRetryEligibleContinuationFailure(toolContinuationFailure)).toBe(true)
    expect(isRetryEligibleContinuationFailure(requestPhaseFailure)).toBe(true)
    expect(isContinuationRetryInput('继续')).toBe(true)
    expect(isContinuationRetryInput('请继续')).toBe(true)
    expect(isContinuationRetryInput('请继续一下')).toBe(true)
    expect(isContinuationRetryInput('请继续吧')).toBe(true)
    expect(isContinuationRetryInput('请继续一下吧')).toBe(true)
    expect(isContinuationRetryInput('continue')).toBe(true)
    expect(isContinuationRetryInput('please continue')).toBe(true)
    expect(isContinuationRetryInput('resume')).toBe(true)
    for (const text of ['继续', 'continue', 'resume', '请继续']) {
      expect(decideFailedContinuationSubmitAction({
        text,
        runtimeFailure: continuationFailure,
        isRetryingFailedContinuation: false,
        failedContinuationAttemptCount: 1,
      })).toBe('retry_failed_continuation')
    }
  })

  it('treats retryable empty-response provider failures as continuation-retry eligible', () => {
    // Distinct kind from generic provider_error so the auto-retry path can
    // suppress it specifically (see shouldScheduleRuntimeAutoRetry below);
    // user-driven "继续" still routes to retry_failed_continuation here.
    const emptyResponseFailure = {
      kind: 'empty_provider_response' as const,
      phase: 'request' as const,
      message: 'No response from kimi-code: provider returned HTTP 200 but no content (stop_reason: end_turn)',
      retryable: true,
    }

    expect(isRetryEligibleContinuationFailure(emptyResponseFailure)).toBe(true)
    expect(decideFailedContinuationSubmitAction({
      text: '继续',
      runtimeFailure: emptyResponseFailure,
      isRetryingFailedContinuation: false,
      failedContinuationAttemptCount: 1,
    })).toBe('retry_failed_continuation')
  })

  it('covers phase=request (first-shot failure) — the common kimi-code case', () => {
    for (const text of ['继续', '请继续', '请继续吧', 'continue']) {
      expect(decideFailedContinuationSubmitAction({
        text,
        runtimeFailure: requestPhaseFailure,
        isRetryingFailedContinuation: false,
        failedContinuationAttemptCount: 1,
      })).toBe('retry_failed_continuation')
    }
  })

  it('dedupes repeated continuation retry submits while a retry is already in flight', () => {
    expect(decideFailedContinuationSubmitAction({
      text: '继续',
      runtimeFailure: continuationFailure,
      isRetryingFailedContinuation: true,
      failedContinuationAttemptCount: 1,
    })).toBe('dedupe_retry_failed_continuation')
  })

  it('stops implicit retry after repeated continuation failures and guides the user', () => {
    expect(decideFailedContinuationSubmitAction({
      text: '请继续',
      runtimeFailure: continuationFailure,
      isRetryingFailedContinuation: false,
      failedContinuationAttemptCount: 2,
    })).toBe('guide_after_repeated_failed_continuation')
  })

  it('does not intercept non-eligible failures or longer freeform continue prompts', () => {
    expect(isRetryEligibleContinuationFailure({
      kind: 'abort',
      phase: 'continuation',
      message: 'Request cancelled by user',
      retryable: false,
    })).toBe(false)

    expect(decideFailedContinuationSubmitAction({
      text: '继续写下去',
      runtimeFailure: continuationFailure,
      isRetryingFailedContinuation: false,
      failedContinuationAttemptCount: 1,
    })).toBe('submit_text')

    expect(decideFailedContinuationSubmitAction({
      text: '继续',
      runtimeFailure: {
        kind: 'post_token_stream_close',
        phase: 'continuation',
        message: 'stream closed before completion',
        retryable: true,
      },
      isRetryingFailedContinuation: false,
      failedContinuationAttemptCount: 1,
    })).toBe('submit_text')
  })

  it('uses a single retry status line regardless of phase', () => {
    expect(formatContinuationRetryStatus(continuationFailure)).toBe('Retrying failed request...')
    expect(formatContinuationRetryStatus(toolContinuationFailure)).toBe('Retrying failed request...')
    expect(formatContinuationRetryStatus(requestPhaseFailure)).toBe('Retrying failed request...')
  })

  it('uses a single repeated-failure guidance regardless of phase', () => {
    expect(formatRepeatedContinuationRetryGuidance(continuationFailure, 2))
      .toBe('Request is still failing after 2 attempts. Use /model to switch, or /retry to force another resend.')
    expect(formatRepeatedContinuationRetryGuidance(toolContinuationFailure, 3))
      .toBe('Request is still failing after 3 attempts. Use /model to switch, or /retry to force another resend.')
    expect(formatRepeatedContinuationRetryGuidance(requestPhaseFailure, 4))
      .toBe('Request is still failing after 4 attempts. Use /model to switch, or /retry to force another resend.')
  })

  it('does not schedule runtime auto-retry for pre-first-token failures or queued user messages', () => {
    const timeoutFailure = {
      kind: 'timeout' as const,
      phase: 'request' as const,
      message: 'kimi-code request failed: timeout after 120s',
      retryable: true,
    }

    expect(shouldScheduleRuntimeAutoRetry({
      runtimeFailure: timeoutFailure,
      taskAborted: false,
      clearEpochUnchanged: true,
      currentRetryCount: 3,
      retryLimit: 8,
      hasQueuedInput: false,
    })).toBe(true)

    expect(shouldScheduleRuntimeAutoRetry({
      runtimeFailure: requestPhaseFailure,
      taskAborted: false,
      clearEpochUnchanged: true,
      currentRetryCount: 3,
      retryLimit: 8,
      hasQueuedInput: false,
    })).toBe(false)

    expect(shouldScheduleRuntimeAutoRetry({
      runtimeFailure: timeoutFailure,
      taskAborted: false,
      clearEpochUnchanged: true,
      currentRetryCount: 3,
      retryLimit: 8,
      hasQueuedInput: true,
    })).toBe(false)
  })

  it('does not schedule runtime auto-retry for empty provider responses (HTTP 200, end_turn, no content)', () => {
    // Real cmux 0.13.20 evidence: 144 kimi-code requests, all HTTP 200, no
    // 429/503, but several with outputTokens<=1 and stop_reason=end_turn.
    // Old policy classified that as `provider_error` + retryable=true and
    // auto-fired the request 8 times in a row, producing the visible
    // "Runtime auto-continue stopped after 8 attempts…" exhaustion line
    // and the smear of repeated retry rows. The new kind lets the
    // auto-continue gate suppress the loop without breaking user-driven
    // /retry or "继续" (those still see retryable=true).
    const emptyResponseFailure = {
      kind: 'empty_provider_response' as const,
      phase: 'request' as const,
      message: 'No response from kimi-code: provider returned HTTP 200 but no content (stop_reason: end_turn)',
      retryable: true,
    }

    expect(shouldScheduleRuntimeAutoRetry({
      runtimeFailure: emptyResponseFailure,
      taskAborted: false,
      clearEpochUnchanged: true,
      currentRetryCount: 0,
      retryLimit: 8,
      hasQueuedInput: false,
    })).toBe(false)

    // Genuine retryable transport-class failures still auto-retry.
    const httpRetryable = {
      kind: 'http_error' as const,
      phase: 'continuation' as const,
      message: 'kimi-code request failed: 502 from provider',
      retryable: true,
    }
    expect(shouldScheduleRuntimeAutoRetry({
      runtimeFailure: httpRetryable,
      taskAborted: false,
      clearEpochUnchanged: true,
      currentRetryCount: 0,
      retryLimit: 8,
      hasQueuedInput: false,
    })).toBe(true)
  })

  it('drains queued user input after retryable failures instead of silently dropping it', () => {
    expect(shouldDrainQueuedInputAfterTurn({
      hasQueuedInput: true,
      taskFailed: true,
      autoRetryFailure: requestPhaseFailure,
    })).toBe(true)

    expect(shouldDrainQueuedInputAfterTurn({
      hasQueuedInput: true,
      taskFailed: true,
      autoRetryFailure: null,
    })).toBe(false)
  })

  it('treats a scheduled auto-retry as interruptible idle, not as a running task that should swallow new input', () => {
    expect(shouldQueueSubmitBehindRunningTask({
      isLoading: false,
      hasActiveTask: false,
      hasScheduledAutoRetry: true,
    })).toBe(false)

    expect(shouldQueueSubmitBehindRunningTask({
      isLoading: true,
      hasActiveTask: true,
      hasScheduledAutoRetry: false,
    })).toBe(true)
  })
})

describe('/reset-circuits and /reset-budgets', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  let usage: UsageTracker

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    usage = new UsageTracker()
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('/reset-circuits returns true and confirms reset', async () => {
    const conv = makeConv()
    expect(await handleSlashCommand('/reset-circuits', conv, usage)).toBe(true)
    const output = logSpy.mock.calls[0]?.[0] as string
    expect(output).toContain('circuit breakers reset')
  })

  it('/reset-budgets returns true and confirms reset', async () => {
    const conv = makeConv()
    expect(await handleSlashCommand('/reset-budgets', conv, usage)).toBe(true)
    const output = logSpy.mock.calls[0]?.[0] as string
    expect(output).toContain('error budget')
  })

  it('/verbose toggles tool result collapsing', async () => {
    const conv = makeConv()
    const collector = new ToolResultCollector()
    expect(collector.verbose).toBe(false)
    // Toggle on
    expect(await handleSlashCommand('/verbose on', conv, usage, undefined, undefined, undefined, undefined, collector)).toBe(true)
    expect(collector.verbose).toBe(true)
    // Toggle off
    expect(await handleSlashCommand('/verbose off', conv, usage, undefined, undefined, undefined, undefined, collector)).toBe(true)
    expect(collector.verbose).toBe(false)
    // Toggle (flip)
    expect(await handleSlashCommand('/verbose', conv, usage, undefined, undefined, undefined, undefined, collector)).toBe(true)
    expect(collector.verbose).toBe(true)
  })

  it('/diff returns true (no git dir is fine)', async () => {
    const conv = makeConv()
    expect(await handleSlashCommand('/diff', conv, usage)).toBe(true)
  })

  it('/verbose in SLASH_COMMANDS for tab completion', () => {
    const [hits] = slashCompleter('/verb')
    expect(hits).toContain('/verbose')
  })

  it('SLASH_COMMANDS includes history size hint in /help', async () => {
    const conv = makeConv()
    await handleSlashCommand('/help', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('Tab for completion')
  })

  // ─── Round 64: additional parity commands ─────────────

  it('/version shows version string', async () => {
    const conv = makeConv()
    const result = await handleSlashCommand('/version', conv, usage)
    expect(result).toBe(true)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toMatch(/OwlCoda v\d+\.\d+/)
  })

  it('/files shows referenced files or empty message', async () => {
    const conv = makeConv()
    const result = await handleSlashCommand('/files', conv, usage)
    expect(result).toBe(true)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toMatch(/No files|Files in context/)
  })

  it('/files lists files from tool_use blocks', async () => {
    const conv = makeConv()
    conv.turns.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: '/tmp/test.txt' } }],
    })
    await handleSlashCommand('/files', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('/tmp/test.txt')
  })

  it('/stats shows session statistics', async () => {
    const conv = makeConv()
    const result = await handleSlashCommand('/stats', conv, usage)
    expect(result).toBe(true)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('Session Statistics')
    expect(output).toContain('Turns')
    expect(output).toContain('Tool uses')
  })

  it('/brief toggles brief mode', async () => {
    const conv = makeConv()
    await handleSlashCommand('/brief on', conv, usage)
    expect(conv.options?.brief).toBe(true)
    logSpy.mockClear()
    await handleSlashCommand('/brief off', conv, usage)
    expect(conv.options?.brief).toBe(false)
  })

  it('/fast toggles fast mode', async () => {
    const conv = makeConv()
    await handleSlashCommand('/fast on', conv, usage)
    expect(conv.options?.fast).toBe(true)
    logSpy.mockClear()
    await handleSlashCommand('/fast', conv, usage)
    expect(conv.options?.fast).toBe(false)
  })

  it('/effort sets effort level', async () => {
    const conv = makeConv()
    await handleSlashCommand('/effort low', conv, usage)
    expect(conv.options?.effort).toBe('low')
    logSpy.mockClear()
    await handleSlashCommand('/effort', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('low')
  })

  it('/vim toggles vim mode', async () => {
    const conv = makeConv()
    await handleSlashCommand('/vim', conv, usage)
    expect(conv.options?.vimMode).toBe(true)
    await handleSlashCommand('/vim', conv, usage)
    expect(conv.options?.vimMode).toBe(false)
  })

  it('/commit shows status in non-git dir', async () => {
    const conv = makeConv()
    const result = await handleSlashCommand('/commit', conv, usage)
    expect(result).toBe(true)
  })

  it('/release-notes shows version info', async () => {
    const conv = makeConv()
    const result = await handleSlashCommand('/release-notes', conv, usage)
    expect(result).toBe(true)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('Release Notes')
  })

  it('/skills shows MCP info when no servers configured', async () => {
    const conv = makeConv()
    const result = await handleSlashCommand('/skills', conv, usage)
    expect(result).toBe(true)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('MCP')
  })

  it('/tasks shows not-yet-available message', async () => {
    const conv = makeConv()
    const result = await handleSlashCommand('/tasks', conv, usage)
    expect(result).toBe(true)
  })

  it('/mcp shows not-yet-available message', async () => {
    const conv = makeConv()
    const result = await handleSlashCommand('/mcp', conv, usage)
    expect(result).toBe(true)
  })

  it('/add-dir requires argument', async () => {
    const conv = makeConv()
    const result = await handleSlashCommand('/add-dir', conv, usage)
    expect(result).toBe(true)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('Usage')
  })

  it('/btw requires argument', async () => {
    const conv = makeConv()
    const result = await handleSlashCommand('/btw', conv, usage)
    expect(result).toBe(true)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('Usage')
  })

  it('/btw surfaces continuation failure without duplicate no-response tail', async () => {
    const conv = makeConv('kimi-code')
    const encoder = new TextEncoder()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'event: message_start\n' +
          'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
        ))
        controller.close()
      },
    }), {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'x-request-id': 'req-btw-close',
      },
    }))

    const result = await handleSlashCommand('/btw 继续', conv, usage, {
      apiBaseUrl: 'http://127.0.0.1:8019',
      apiKey: 'test-key',
      model: 'kimi-code',
    }, undefined, new ToolDispatcher())

    expect(result).toBe(true)
    const errorOutput = errorSpy.mock.calls.flat().join(' ')
    const logOutput = logSpy.mock.calls.flat().join(' ')
    expect(errorOutput).toContain('continuation failed: stream closed before first token')
    expect(errorOutput).not.toContain('No response from model')
    expect(logOutput).not.toContain('(No response from model)')
    expect(logOutput).not.toContain('No tokens reported')
  }, 10000)

  it('/help includes Ctrl+R hint', async () => {
    const conv = makeConv()
    await handleSlashCommand('/help', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('Ctrl+R')
  })

  it('/help includes interaction policy note', async () => {
    const conv = makeConv()
    await handleSlashCommand('/help', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('Interaction:')
    expect(output).toContain('selection-first')
  })

  it('/help includes new command categories', async () => {
    const conv = makeConv()
    await handleSlashCommand('/help', conv, usage)
    const output = logSpy.mock.calls.map(c => c[0]).join('\n')
    expect(output).toContain('Git & Code')
    expect(output).toContain('/brief')
    expect(output).toContain('/version')
    expect(output).toContain('/files')
    expect(output).toContain('/stats')
  })

  it('new commands in SLASH_COMMANDS for tab completion', () => {
    const newCmds = ['/version', '/files', '/stats', '/brief', '/fast', '/effort', '/vim', '/commit', '/release-notes', '/skills', '/tasks', '/mcp', '/add-dir']
    for (const cmd of newCmds) {
      const [hits] = slashCompleter(cmd.slice(0, 4))
      expect(hits.some(h => h === cmd)).toBe(true)
    }
  })

  it('/search in SLASH_COMMANDS for tab completion', () => {
    const [hits] = slashCompleter('/sea')
    expect(hits).toContain('/search')
  })

  it('completes file paths with ./ prefix', () => {
    const [hits, token] = slashCompleter('./src/')
    expect(token).toBe('./src/')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some(h => h.startsWith('./src/'))).toBe(true)
  })

  it('returns empty for plain words (no path pattern)', () => {
    const [hits] = slashCompleter('hello world')
    expect(hits).toEqual([])
  })
})

describe('/thinking command', () => {
  let conv: any
  let usage: any

  beforeEach(() => {
    conv = createConversation({ system: 'test', model: 'test-model', maxTokens: 100, tools: [] })
    usage = new UsageTracker()
  })

  it('sets thinking on (collapsed by default)', async () => {
    const ts: ThinkingState = { mode: 'collapsed', lastThinking: '' }
    await handleSlashCommand('/thinking on', conv, usage, undefined, undefined, undefined, undefined, undefined, undefined, undefined, ts)
    expect(conv.options.thinking).toBe(true)
    expect(ts.mode).toBe('collapsed')
  })

  it('sets thinking to verbose mode', async () => {
    const ts: ThinkingState = { mode: 'collapsed', lastThinking: '' }
    await handleSlashCommand('/thinking verbose', conv, usage, undefined, undefined, undefined, undefined, undefined, undefined, undefined, ts)
    expect(conv.options.thinking).toBe(true)
    expect(ts.mode).toBe('verbose')
  })

  it('turns thinking off', async () => {
    const ts: ThinkingState = { mode: 'verbose', lastThinking: '' }
    await handleSlashCommand('/thinking off', conv, usage, undefined, undefined, undefined, undefined, undefined, undefined, undefined, ts)
    expect(conv.options.thinking).toBe(false)
    expect(ts.mode).toBe('collapsed')
  })

  it('/thinking show displays last thinking content', async () => {
    const ts: ThinkingState = { mode: 'collapsed', lastThinking: 'The user wants to analyze data.' }
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await handleSlashCommand('/thinking show', conv, usage, undefined, undefined, undefined, undefined, undefined, undefined, undefined, ts)
    const output = spy.mock.calls.flat().join(' ')
    expect(output).toContain('The user wants to analyze data.')
    spy.mockRestore()
  })
})

describe('REPL input helpers', () => {
  it('detects kitty Shift+Enter escape sequence', () => {
    expect(detectInputSignals('\x1b[13;2u')).toEqual({
      continueMultiline: true,
      pasteStart: false,
      pasteEnd: false,
    })
  })

  it('detects CSI modified Enter escape sequence', () => {
    expect(detectInputSignals('\x1b[13~')).toEqual({
      continueMultiline: true,
      pasteStart: false,
      pasteEnd: false,
    })
  })

  it('detects modified Enter from keypress metadata', () => {
    expect(detectInputSignals('', { name: 'return', shift: true })).toEqual({
      continueMultiline: true,
      pasteStart: false,
      pasteEnd: false,
    })
  })

  it('formats resume command without legacy --native flag', () => {
    expect(formatResumeCommand('conv-123')).toBe('owlcoda --resume conv-123')
  })

  it('classifies task-running input as interrupt-only', () => {
    expect(classifyResolvedInput('', true)).toBe('task_ignore')
    expect(classifyResolvedInput('/help', true)).toBe('task_block_slash')
    expect(classifyResolvedInput('follow up', true)).toBe('task_ignore')
    expect(classifyResolvedInput('', false)).toBe('idle_empty')
    expect(classifyResolvedInput('hello', false)).toBe('submit')
  })

  it('composes buffered multiline drafts without leaking empty lines', () => {
    expect(composeBufferedInput([], 'hello')).toBe('hello')
    expect(composeBufferedInput(['first', 'second'], 'third')).toBe('first\nsecond\nthird')
    expect(composeBufferedInput(['first', 'second'], '')).toBe('first\nsecond')
  })

  it('suppresses readline repaint while a task is running and the prompt dock is hidden', () => {
    expect(shouldSuppressReadlineRefresh(false, true)).toBe(true)
    expect(shouldSuppressReadlineRefresh(true, true)).toBe(false)
    expect(shouldSuppressReadlineRefresh(false, false)).toBe(false)
  })

  it('strips leaked modified-enter artifacts from submitted lines', () => {
    expect(stripModifiedEnterArtifacts('hello13~')).toBe('hello')
    expect(stripModifiedEnterArtifacts('13~13~13~')).toBe('')
    expect(stripModifiedEnterArtifacts('hello[13~')).toBe('hello')
    expect(stripModifiedEnterArtifacts('hello[13;2u')).toBe('hello')
  })

  it('buffers split modified-enter escape sequences across raw stdin chunks', () => {
    expect(detectBufferedInputSignals('\x1b')).toEqual({
      continueMultiline: false,
      pasteStart: false,
      pasteEnd: false,
      remainder: '\x1b',
    })
    expect(detectBufferedInputSignals('[13;2u', '\x1b')).toEqual({
      continueMultiline: true,
      pasteStart: false,
      pasteEnd: false,
      remainder: '',
    })
  })

  it('buffers split bracketed-paste markers across raw stdin chunks', () => {
    expect(detectBufferedInputSignals('\x1b[20')).toEqual({
      continueMultiline: false,
      pasteStart: false,
      pasteEnd: false,
      remainder: '\x1b[20',
    })
    expect(detectBufferedInputSignals('0~', '\x1b[20')).toEqual({
      continueMultiline: false,
      pasteStart: true,
      pasteEnd: false,
      remainder: '',
    })
  })

  it('builds a synthetic-line suppression window for direct Shift+Enter handling', () => {
    const suppression = createSyntheticLineSuppression('hello', 1000)
    expect(suppression.until).toBe(1100)
    expect(suppression.acceptedLines).toEqual(['', 'hello'])
  })

  it('ignores duplicate line events emitted by the same Shift+Enter press', () => {
    const suppression = createSyntheticLineSuppression('hello', 1000)
    expect(shouldIgnoreSyntheticLine('hello', suppression, 1100)).toBe(true)
    expect(shouldIgnoreSyntheticLine('hello13~', suppression, 1100)).toBe(true)
    expect(shouldIgnoreSyntheticLine('', suppression, 1100)).toBe(true)
    expect(shouldIgnoreSyntheticLine('hello again', suppression, 1100)).toBe(false)
    expect(shouldIgnoreSyntheticLine('hello', suppression, 1300)).toBe(false)
  })

  it('builds multiline prompt rows with committed lines and placeholders', () => {
    const view = buildPromptBufferRows(['first line'], '', 4)
    expect(view.cursorRow).toBe(1)
    expect(view.rows[0]).toEqual({ text: 'first line', placeholder: false })
    expect(view.rows[1]).toEqual({ text: '', placeholder: false })
    expect(view.rows[2]).toEqual({ text: '', placeholder: true })
    expect(view.rows[3]).toEqual({ text: '', placeholder: true })
  })

  it('arms slash picker only for a bare slash on an empty line', () => {
    expect(shouldOpenSlashPickerOnKeypress('/', '', false, false, false)).toBe(true)
    expect(shouldOpenSlashPickerOnKeypress('/', '/', false, false, false)).toBe(true)
  })

  it('does not open slash picker when slash is part of existing input', () => {
    expect(shouldOpenSlashPickerOnKeypress('/', 'hello/', false, false, false)).toBe(false)
    expect(shouldOpenSlashPickerOnKeypress('/', ' /', false, false, false)).toBe(false)
  })

  it('does not open slash picker while a task or multiline compose is active', () => {
    expect(shouldOpenSlashPickerOnKeypress('/', '', true, false, false)).toBe(false)
    expect(shouldOpenSlashPickerOnKeypress('/', '', false, true, false)).toBe(false)
    expect(shouldOpenSlashPickerOnKeypress('/', '', false, false, true)).toBe(false)
  })
})

// R115: Tests for previously untested commands
describe('Additional slash commands', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let usage: UsageTracker

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    usage = new UsageTracker()
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  it('/context shows context window usage', async () => {
    const conv = makeConv()
    addUserMessage(conv, 'hello world')
    expect(await handleSlashCommand('/context', conv, usage)).toBe(true)
    const output = logSpy.mock.calls.flat().join(' ')
    expect(output).toContain('Context Window')
    expect(output).toContain('Breakdown')
  })

  it('/budget shows token budget', async () => {
    const conv = makeConv()
    expect(await handleSlashCommand('/budget', conv, usage)).toBe(true)
    const output = logSpy.mock.calls.flat().join(' ')
    expect(output).toMatch(/Context|Budget|token/i)
  })

  it('/tokens is alias for /cost', async () => {
    const conv = makeConv()
    expect(await handleSlashCommand('/tokens', conv, usage)).toBe(true)
    const output = logSpy.mock.calls.flat().join(' ')
    expect(output).toMatch(/Tokens|Usage|total/i)
  })

  it('/quit calls process.exit', async () => {
    const conv = makeConv()
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any)
    await handleSlashCommand('/quit', conv, usage)
    expect(exitSpy).toHaveBeenCalledWith(0)
    exitSpy.mockRestore()
  })

  it('/exit calls process.exit', async () => {
    const conv = makeConv()
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any)
    await handleSlashCommand('/exit', conv, usage)
    expect(exitSpy).toHaveBeenCalledWith(0)
    exitSpy.mockRestore()
  })

  it('/theme with name switches theme', async () => {
    const conv = makeConv()
    expect(await handleSlashCommand('/theme dark', conv, usage)).toBe(true)
    const output = logSpy.mock.calls.flat().join(' ')
    expect(output).toMatch(/theme|Theme|dark/i)
  })

  it('/theme with invalid name shows error', async () => {
    const conv = makeConv()
    expect(await handleSlashCommand('/theme nonexistent', conv, usage)).toBe(true)
    const output = logSpy.mock.calls.flat().join(' ')
    expect(output).toMatch(/unknown|not found|available/i)
  })

  it('/permissions shows permissions state', async () => {
    const conv = makeConv()
    expect(await handleSlashCommand('/permissions', conv, usage)).toBe(true)
    const output = logSpy.mock.calls.flat().join(' ')
    expect(output).toContain('Permissions')
  })

  it('/undo on empty conversation shows message', async () => {
    const conv = makeConv()
    expect(await handleSlashCommand('/undo', conv, usage)).toBe(true)
    const output = logSpy.mock.calls.flat().join(' ')
    expect(output).toMatch(/nothing to undo|empty/i)
  })

  it('/undo removes last turn pair', async () => {
    const conv = makeConv()
    addUserMessage(conv, 'hello')
    conv.turns.push({ role: 'assistant', content: [{ type: 'text', text: 'hi' }] })
    addUserMessage(conv, 'world')
    conv.turns.push({ role: 'assistant', content: [{ type: 'text', text: 'bye' }] })
    expect(conv.turns.length).toBe(4)
    expect(await handleSlashCommand('/undo', conv, usage)).toBe(true)
    expect(conv.turns.length).toBe(2)
  })

  it('/rewind N removes last N turn pairs', async () => {
    const conv = makeConv()
    addUserMessage(conv, 'a')
    conv.turns.push({ role: 'assistant', content: [{ type: 'text', text: 'A' }] })
    addUserMessage(conv, 'b')
    conv.turns.push({ role: 'assistant', content: [{ type: 'text', text: 'B' }] })
    addUserMessage(conv, 'c')
    conv.turns.push({ role: 'assistant', content: [{ type: 'text', text: 'C' }] })
    expect(conv.turns.length).toBe(6)
    expect(await handleSlashCommand('/rewind 2', conv, usage)).toBe(true)
    expect(conv.turns.length).toBe(2)
  })

  it('/color without arg shows color status', async () => {
    const conv = makeConv()
    expect(await handleSlashCommand('/color', conv, usage)).toBe(true)
    const output = logSpy.mock.calls.flat().join(' ')
    expect(output).toMatch(/color|Color/i)
  })

  it('/plan shows plan mode status', async () => {
    const conv = makeConv()
    expect(await handleSlashCommand('/plan', conv, usage)).toBe(true)
    const output = logSpy.mock.calls.flat().join(' ')
    expect(output).toMatch(/plan/i)
  })

  it('/save saves current session', async () => {
    const conv = makeConv()
    addUserMessage(conv, 'test save')
    expect(await handleSlashCommand('/save', conv, usage)).toBe(true)
    const output = logSpy.mock.calls.flat().join(' ')
    expect(output).toMatch(/saved|Session/i)
  })

  it('/sessions lists saved sessions', async () => {
    const conv = makeConv()
    expect(await handleSlashCommand('/sessions', conv, usage)).toBe(true)
  })

  it('/login shows login info', async () => {
    const conv = makeConv()
    expect(await handleSlashCommand('/login', conv, usage)).toBe(true)
    const output = logSpy.mock.calls.flat().join(' ')
    expect(output).toMatch(/login|auth|API|server|connection/i)
  })

  it('/login reads cloud model status from admin model truth', async () => {
    const conv = makeConv()
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      runtimeOk: true,
      runtimeSource: 'runtime_status',
      runtimeProbeDetail: 'ready',
      runtimeModelCount: 1,
      statuses: [{
        id: 'cloud-model',
        label: 'Cloud Model',
        providerKind: 'cloud',
        presentIn: { config: true, router: false, discovered: false, catalog: false },
        availability: { kind: 'missing_key', envName: 'OPENAI_API_KEY' },
        raw: { config: { id: 'cloud-model', endpoint: 'https://api.example.com', apiKeyEnv: 'OPENAI_API_KEY' } },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch

    try {
      expect(await handleSlashCommand('/login', conv, usage, {
        apiBaseUrl: 'http://127.0.0.1:8019',
        apiKey: 'admin-token',
        model: 'cloud-model',
      })).toBe(true)
    } finally {
      globalThis.fetch = origFetch
    }

    const output = logSpy.mock.calls.flat().join(' ')
    expect(output).toContain('cloud-model')
    expect(output).toContain('OPENAI_API_KEY')
    expect(output).toContain('https://api.example.com')
  })

  it('/login writes api key through ModelConfigMutator path', async () => {
    const conv = makeConv()
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owlcoda-login-'))
    const prevHome = process.env.OWLCODA_HOME
    process.env.OWLCODA_HOME = tmpDir
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
      models: [{
        id: 'cloud-model',
        label: 'Cloud Model',
        backendModel: 'cloud-model',
        aliases: [],
        tier: 'cloud',
        endpoint: 'https://api.example.com',
      }],
      defaultModel: 'legacy-default',
      modelMap: {},
      reverseMapInResponse: true,
    }, null, 2))

    try {
      expect(await handleSlashCommand('/login cloud-model sk-test', conv, usage, {
        apiBaseUrl: 'http://127.0.0.1:8019',
        apiKey: 'admin-token',
        model: 'cloud-model',
      })).toBe(true)
      const updated = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'))
      expect(updated.models[0].apiKey).toBe('sk-test')
      expect(updated.defaultModel).toBeUndefined()
    } finally {
      if (prevHome === undefined) delete process.env.OWLCODA_HOME
      else process.env.OWLCODA_HOME = prevHome
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('/models edit <id> prints a focused browser handoff URL', async () => {
    const conv = makeConv()
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owlcoda-models-handoff-'))
    const prevCwd = process.cwd()
    const prevHome = process.env.OWLCODA_HOME
    process.env.OWLCODA_HOME = tmpDir
    process.chdir(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
      models: [{
        id: 'cloud-model',
        label: 'Cloud Model',
        backendModel: 'cloud-model',
        aliases: [],
        tier: 'cloud',
        endpoint: 'https://api.example.com',
      }],
      modelMap: {},
      reverseMapInResponse: true,
    }, null, 2))

    try {
      expect(await handleSlashCommand('/models edit cloud-model', conv, usage, {
        apiBaseUrl: 'http://127.0.0.1:8019',
        apiKey: 'admin-token',
        model: 'cloud-model',
      })).toBe(true)
    } finally {
      process.chdir(prevCwd)
      if (prevHome === undefined) delete process.env.OWLCODA_HOME
      else process.env.OWLCODA_HOME = prevHome
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }

    const output = logSpy.mock.calls.flat().join(' ')
    expect(output).toContain('Admin URL:')
    expect(output).toContain('#/models?select=cloud-model')
    expect(output).toContain('Browser auto-open is disabled by default')
  })

  it('/models browser catalog opens a catalog handoff URL', async () => {
    const conv = makeConv()
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owlcoda-models-browser-'))
    const prevCwd = process.cwd()
    process.chdir(tmpDir)

    try {
      expect(await handleSlashCommand('/models browser catalog', conv, usage, {
        apiBaseUrl: 'http://127.0.0.1:8019',
        apiKey: 'admin-token',
        model: 'cloud-model',
      })).toBe(true)
    } finally {
      process.chdir(prevCwd)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }

    const output = logSpy.mock.calls.flat().join(' ')
    expect(output).toContain('Admin URL:')
    expect(output).toContain('#/catalog')
  })

  it('/hooks shows hooks info', async () => {
    const conv = makeConv()
    expect(await handleSlashCommand('/hooks', conv, usage)).toBe(true)
    const output = logSpy.mock.calls.flat().join(' ')
    expect(output).toMatch(/hooks|Hook/i)
  })

  it('/review shows review info', async () => {
    const conv = makeConv()
    expect(await handleSlashCommand('/review', conv, usage)).toBe(true)
    const output = logSpy.mock.calls.flat().join(' ')
    expect(output).toMatch(/review|Review/i)
  })

  it('/rename changes session name', async () => {
    const conv = makeConv()
    conv.sessionId = 'test-session-rename'
    expect(await handleSlashCommand('/rename new-name', conv, usage)).toBe(true)
    const output = logSpy.mock.calls.flat().join(' ')
    expect(output).toMatch(/rename|new-name/i)
  })

  it('/memory shows memory info', async () => {
    const conv = makeConv()
    expect(await handleSlashCommand('/memory', conv, usage)).toBe(true)
    const output = logSpy.mock.calls.flat().join(' ')
    expect(output).toMatch(/memory|Memory|OWLCODA/i)
  })
})

// ─── Stabilization: REPL interaction patterns ──────────────────

describe('REPL interaction stabilization', () => {
  it('slash picker items include all registered commands', () => {
    const items = buildSlashPickerItems()
    expect(items.length).toBeGreaterThan(10)
    // Every item should have label and value
    for (const item of items) {
      expect(item.label).toBeTruthy()
      expect(item.value).toBeTruthy()
      expect(item.label.startsWith('/')).toBe(true)
    }
    // Commands requiring args should be in the set
    expect(SLASH_COMMANDS_REQUIRING_ARGS.has('/resume')).toBe(true)
    expect(SLASH_COMMANDS_REQUIRING_ARGS.has('/model')).toBe(false)
  })

  it('every slash picker item has a meaningful description', () => {
    const items = buildSlashPickerItems()
    const withoutDescription = items.filter((item) => !item.description || item.description === 'Command')
    // All commands should have real descriptions (not the fallback 'Command')
    expect(withoutDescription).toEqual([])
  })

  it('fuzzy search on slash picker items matches descriptions', () => {
    const items = buildSlashPickerItems()
    // Search for 'switch' should match '/model' (description: 'Switch models')
    const modelItem = items.find((item: any) => item.value === '/model')!
    const score = fuzzyMatch('switch', `${modelItem.label} ${modelItem.description ?? ''}`)
    expect(score).toBeGreaterThanOrEqual(0)
  })

  it('fuzzy search on slash picker items matches partial command names', () => {
    const items = buildSlashPickerItems()
    // Search for 'mod' should match '/model'
    const modelItem = items.find((item: any) => item.value === '/model')!
    const score = fuzzyMatch('mod', `${modelItem.label} ${modelItem.description ?? ''}`)
    expect(score).toBeGreaterThanOrEqual(0)
  })

  it('active task blocks all user input from submitting', () => {
    // Simulates the "Enter spam during active task" scenario
    expect(classifyResolvedInput('hello', true)).toBe('task_ignore')
    expect(classifyResolvedInput('', true)).toBe('task_ignore')
    expect(classifyResolvedInput('/help', true)).toBe('task_block_slash')
    expect(classifyResolvedInput('/model foo', true)).toBe('task_block_slash')
  })

  it('idle state allows all input to submit', () => {
    expect(classifyResolvedInput('hello', false)).toBe('submit')
    expect(classifyResolvedInput('/help', false)).toBe('submit')
    expect(classifyResolvedInput('/model', false)).toBe('submit')
  })

  it('slash picker does not arm during active task', () => {
    expect(shouldOpenSlashPickerOnKeypress('/', '', true, false, false)).toBe(false)
  })

  it('slash picker does not arm when picker is already open', () => {
    expect(shouldOpenSlashPickerOnKeypress('/', '', false, false, true)).toBe(false)
  })

  it('slash picker does not arm during multiline compose', () => {
    expect(shouldOpenSlashPickerOnKeypress('/', '', false, true, false)).toBe(false)
  })

  it('slash picker does not arm for non-slash keystrokes', () => {
    expect(shouldOpenSlashPickerOnKeypress('a', '', false, false, false)).toBe(false)
    expect(shouldOpenSlashPickerOnKeypress(' ', '', false, false, false)).toBe(false)
  })

  it('interrupt during active task resets output gating (simulates input clear)', () => {
    // The actual input clearing happens in the React component (setInputValue('')
    // in handleInterrupt), but here we verify the state machine allows the
    // transition back to idle cleanly.
    const runtime = createReplRuntimeState()
    const task = startReplTask(runtime)
    expect(canWriteTaskOutput(runtime, task)).toBe(true)

    // Interrupt
    interruptReplTask(runtime)
    expect(canWriteTaskOutput(runtime, task)).toBe(false)
    expect(runtime.phase).toBe('interrupted')

    // Clean up and return to idle
    finishReplTask(runtime, task, 'interrupted')
    resetReplToIdle(runtime)
    expect(runtime.phase).toBe('idle')
    expect(runtime.activeTask).toBeNull()
  })

  it('multiple Ctrl+C presses should not corrupt state', () => {
    const runtime = createReplRuntimeState()
    const task = startReplTask(runtime)

    // First Ctrl+C: interrupt
    interruptReplTask(runtime)
    expect(canWriteTaskOutput(runtime, task)).toBe(false)

    // Second Ctrl+C while task is still cleaning up: should be safe
    interruptReplTask(runtime)
    expect(runtime.phase).toBe('interrupted')

    // Cleanup completes
    finishReplTask(runtime, task, 'interrupted')
    resetReplToIdle(runtime)
    expect(runtime.phase).toBe('idle')

    // Can start a new task
    const task2 = startReplTask(runtime)
    expect(canWriteTaskOutput(runtime, task2)).toBe(true)
    finishReplTask(runtime, task2, 'completed')
    resetReplToIdle(runtime)
    expect(runtime.phase).toBe('idle')
  })
})

// ─── Transcript viewport utilities ──────────────────────────────

describe('estimateWrappedLineCount', () => {
  it('counts a single short line as 1', () => {
    expect(estimateWrappedLineCount('hello', 80)).toBe(1)
  })

  it('counts wrapped lines correctly', () => {
    // 20 chars in 10-wide terminal = 2 lines
    expect(estimateWrappedLineCount('a'.repeat(20), 10)).toBe(2)
  })

  it('handles multi-line text', () => {
    expect(estimateWrappedLineCount('line1\nline2\nline3', 80)).toBe(3)
  })

  it('handles empty string as 1 line', () => {
    expect(estimateWrappedLineCount('', 80)).toBe(1)
  })

  it('wraps long lines across multiple rows', () => {
    // 25 chars in 10-wide terminal = ceil(25/10) = 3 lines
    expect(estimateWrappedLineCount('a'.repeat(25), 10)).toBe(3)
  })

  it('ignores ANSI escape sequences in width calculation', () => {
    const ansiText = '\x1b[31mhello\x1b[0m'
    // 'hello' is 5 chars, fits in 80 columns
    expect(estimateWrappedLineCount(ansiText, 80)).toBe(1)
  })
})

describe('selectVisibleTranscriptItems', () => {
  const makeItems = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `item-${i}`,
      text: `Line ${i}`,
    }))

  it('returns empty array for no items', () => {
    expect(selectVisibleTranscriptItems([], 80, 10)).toEqual([])
  })

  it('returns empty array for zero budget', () => {
    expect(selectVisibleTranscriptItems(makeItems(5), 80, 0)).toEqual([])
  })

  it('returns all items when budget is sufficient', () => {
    const items = makeItems(3)
    const result = selectVisibleTranscriptItems(items, 80, 10)
    expect(result).toHaveLength(3)
    expect(result[0]!.id).toBe('item-0')
    expect(result[2]!.id).toBe('item-2')
  })

  it('returns only the latest items when budget is tight', () => {
    const items = makeItems(10)
    // Each item is 1 line (short text, 80 cols), budget = 3 lines
    const result = selectVisibleTranscriptItems(items, 80, 3)
    expect(result).toHaveLength(3)
    // Should be the LAST 3 items
    expect(result[0]!.id).toBe('item-7')
    expect(result[1]!.id).toBe('item-8')
    expect(result[2]!.id).toBe('item-9')
  })

  it('includes at least one item even if it exceeds budget', () => {
    // A single item that wraps to 5 lines, but budget is 2
    const items = [{ id: 'big', text: 'a'.repeat(50) }]
    const result = selectVisibleTranscriptItems(items, 10, 2)
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('big')
  })

  it('works with scroll offset via pre-slicing', () => {
    const items = makeItems(10)
    // Simulate scrollOffset=3: only show first 7 items
    const sliced = items.slice(0, 7)
    const result = selectVisibleTranscriptItems(sliced, 80, 3)
    expect(result).toHaveLength(3)
    // Should be items 4, 5, 6 (the last 3 of the sliced array)
    expect(result[0]!.id).toBe('item-4')
    expect(result[2]!.id).toBe('item-6')
  })

  it('short transcript returns all items (no gap at top)', () => {
    // With 2 items and budget of 20, both items should be returned
    const items = makeItems(2)
    const result = selectVisibleTranscriptItems(items, 80, 20)
    expect(result).toHaveLength(2)
    // The UI renders short transcripts from the top of the transcript area,
    // matching the first-screen design instead of burying the welcome block.
  })
})

// ─── Line-based windowed viewport (upstream-aligned) ────────────

describe('selectVisibleTranscriptWindow', () => {
  const makeItems = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `item-${i}`,
      text: `Line ${i}`,
    }))

  it('returns empty for no items', () => {
    const result = selectVisibleTranscriptWindow([], 80, 10, 0)
    expect(result.visible).toEqual([])
    expect(result.totalLines).toBe(0)
  })

  it('returns all items at live (offset=0) when budget sufficient', () => {
    const items = makeItems(5)
    const result = selectVisibleTranscriptWindow(items, 80, 20, 0)
    expect(result.visible).toHaveLength(5)
    expect(result.clampedOffset).toBe(0)
    expect(result.maxScrollOffset).toBe(0)
  })

  it('shows only bottom items when budget is tight at live', () => {
    const items = makeItems(10) // each 1 line, total=10 lines
    const result = selectVisibleTranscriptWindow(items, 80, 3, 0)
    expect(result.visible).toHaveLength(3)
    expect(result.visible[0]!.id).toBe('item-7')
    expect(result.visible[2]!.id).toBe('item-9')
    expect(result.hiddenAboveCount).toBe(7)
    expect(result.hiddenBelowCount).toBe(0)
  })

  it('scrolling away shows older items', () => {
    const items = makeItems(10) // total=10 lines
    // Scroll up 5 lines from live
    const result = selectVisibleTranscriptWindow(items, 80, 3, 5)
    expect(result.visible).toHaveLength(3)
    // viewEnd = 10 - 5 = 5, viewStart = 5 - 3 = 2
    // Items 2, 3, 4
    expect(result.visible[0]!.id).toBe('item-2')
    expect(result.visible[2]!.id).toBe('item-4')
    expect(result.hiddenAboveCount).toBe(2)
    expect(result.hiddenBelowCount).toBe(5)
  })

  it('clamps offset to maxScrollOffset', () => {
    const items = makeItems(10) // total=10 lines, budget=3
    const result = selectVisibleTranscriptWindow(items, 80, 3, 999)
    // maxScrollOffset = 10 - 3 = 7, so clamped to 7
    expect(result.clampedOffset).toBe(7)
    // viewEnd = 10 - 7 = 3, viewStart = 0
    expect(result.visible[0]!.id).toBe('item-0')
    expect(result.visible).toHaveLength(3)
    expect(result.hiddenAboveCount).toBe(0)
    expect(result.hiddenBelowCount).toBe(7)
  })

  it('return-to-live: offset=0 shows newest', () => {
    const items = makeItems(20)
    const result = selectVisibleTranscriptWindow(items, 80, 5, 0)
    expect(result.visible[result.visible.length - 1]!.id).toBe('item-19')
    expect(result.clampedOffset).toBe(0)
  })

  it('provides line-level position info', () => {
    const items = makeItems(100) // 100 lines total
    const result = selectVisibleTranscriptWindow(items, 80, 10, 0)
    expect(result.totalLines).toBe(100)
    expect(result.viewEndLine).toBe(100)
    expect(result.viewStartLine).toBe(90)
    expect(result.maxScrollOffset).toBe(90)
  })

  it('handles multi-line items correctly', () => {
    const items = [
      { id: 'short', text: 'Hello' },         // 1 line
      { id: 'long', text: 'a'.repeat(200) },  // 3 lines at width=80
      { id: 'multi', text: 'a\nb\nc' },       // 3 lines
    ]
    const result = selectVisibleTranscriptWindow(items, 80, 20, 0)
    expect(result.totalLines).toBe(7) // 1 + 3 + 3
    expect(result.visible).toHaveLength(3)
  })

  it('scroll away during loading tracks hidden below', () => {
    const items = makeItems(20)
    const result = selectVisibleTranscriptWindow(items, 80, 5, 10)
    expect(result.hiddenBelowCount).toBeGreaterThan(0)
    expect(result.hiddenAboveCount).toBeGreaterThan(0)
  })

  it('slices overlapping items to the visible display lines', () => {
    const items = [
      {
        id: 'tool-output',
        text: [
          'row 0',
          'row 1',
          'row 2',
          'row 3',
          'row 4',
          'row 5',
          'row 6',
          'row 7',
        ].join('\n'),
      },
    ]

    const result = selectVisibleTranscriptWindow(items, 80, 3, 2)

    expect(result.visible).toHaveLength(1)
    expect(result.visible[0]!.text).toBe('row 3\nrow 4\nrow 5')
  })

  it('slices inside wrapped long lines instead of returning the whole item', () => {
    const items = [{ id: 'wrapped', text: 'a'.repeat(25) }]

    const result = selectVisibleTranscriptWindow(items, 10, 1, 1)

    expect(result.visible).toHaveLength(1)
    expect(result.visible[0]!.text).toBe('aaaaaaaaaa')
  })

  it('history not lost: all items visible when budget >= totalLines', () => {
    const items = makeItems(10)
    const result = selectVisibleTranscriptWindow(items, 80, 100, 0)
    expect(result.visible).toHaveLength(10)
    expect(result.hiddenAboveCount).toBe(0)
    expect(result.hiddenBelowCount).toBe(0)
  })

  it('maxScrollOffset is 0 when transcript fits in budget', () => {
    const items = makeItems(3)
    const result = selectVisibleTranscriptWindow(items, 80, 10, 0)
    expect(result.maxScrollOffset).toBe(0)
    expect(result.clampedOffset).toBe(0)
  })

  // ── P0 newest-turn-atomic policy (real-machine QA regression) ──
  //
  // Real-machine bug: user submits a long multi-line message; at live
  // (scrollOffset=0), the naive "last budgetLines of transcript"
  // policy slices the newest block from the TOP and shows only its
  // tail. User reads "just the last 4 lines of what I sent" and
  // believes their submission was lost — even though the model
  // received it intact.
  //
  // Fix: at live, anchor on the newest item as the visibility unit.
  // Newest must appear whole; if it alone exceeds budget, show its
  // FIRST lines (not its last lines) so the user sees their
  // submission's beginning.

  it('live: newest item rendered whole, never sliced from top, when it fits', () => {
    // Older item is small, newest is exactly at budget — the boundary case.
    const items: TranscriptItem[] = [
      { id: 'old', text: 'older turn' },                                 // 1 line
      { id: 'newest', text: 'line A\nline B\nline C\nline D\nline E' },  // 5 lines
    ]
    const result = selectVisibleTranscriptWindow(items, 80, 5, 0)
    // Newest item visible in full, identified by its original id
    // (not the sliced `id::start-end` form).
    const newestVisible = result.visible.find((v) => v.id === 'newest')
    expect(newestVisible).toBeDefined()
    expect(newestVisible!.text).toBe('line A\nline B\nline C\nline D\nline E')
  })

  it('live: newest item larger than budget shows TOP lines, not bottom', () => {
    // The exact real-machine scenario: newest user block is longer
    // than available budget. Must show the HEAD of the message so
    // the user recognizes what they sent.
    const newestText = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
    const items: TranscriptItem[] = [
      { id: 'prior', text: 'assistant text' },
      { id: 'newest', text: newestText }, // 12 lines
    ]
    const result = selectVisibleTranscriptWindow(items, 80, 6, 0)

    // One sliced item (the newest), no backfill space for older.
    expect(result.visible).toHaveLength(1)
    const visible = result.visible[0]!
    // Sliced id carries the 0-N range marker so consumers can tell
    // this is a partial render of the newest item.
    expect(visible.id).toMatch(/^newest::0-6$/)
    // First 6 lines (head), NOT last 6 (tail) — this is the guard.
    expect(visible.text).toBe('line 0\nline 1\nline 2\nline 3\nline 4\nline 5')
    expect(visible.text).not.toContain('line 11')
    expect(visible.text).not.toContain('line 10')
  })

  it('live: newest fits, older item back-filled with TAIL slice (reading continuity)', () => {
    // Newest uses 2 lines; budget 5 leaves 3 for older items.
    // The older item is 7 lines — must be sliced to its BOTTOM 3
    // lines so the transition flows: older-tail → newest-head.
    const oldText = Array.from({ length: 7 }, (_, i) => `old-${i}`).join('\n')
    const items: TranscriptItem[] = [
      { id: 'old', text: oldText },            // 7 lines
      { id: 'newest', text: 'new A\nnew B' }, // 2 lines
    ]
    const result = selectVisibleTranscriptWindow(items, 80, 5, 0)

    expect(result.visible).toHaveLength(2)
    // Older item sliced from TOP — keeps its tail (lines 4,5,6).
    const oldVisible = result.visible[0]!
    expect(oldVisible.id).toMatch(/^old::4-7$/)
    expect(oldVisible.text).toBe('old-4\nold-5\nold-6')
    // Newest item whole, original id.
    const newestVisible = result.visible[1]!
    expect(newestVisible.id).toBe('newest')
    expect(newestVisible.text).toBe('new A\nnew B')
  })

  it('live: newest fits with exact remaining budget for older item (no slice)', () => {
    const items: TranscriptItem[] = [
      { id: 'old', text: 'a\nb\nc' },     // 3 lines
      { id: 'newest', text: 'x\ny' },     // 2 lines
    ]
    const result = selectVisibleTranscriptWindow(items, 80, 5, 0)
    // Both items fit exactly — no slicing, original ids preserved.
    expect(result.visible).toHaveLength(2)
    expect(result.visible[0]!.id).toBe('old')
    expect(result.visible[1]!.id).toBe('newest')
  })

  it('live: multi-line wrapping (CJK-width etc.) respects newest-turn-atomic policy', () => {
    // Wrapped long line counts as multiple display lines. Budget=4,
    // newest item is a single logical line that wraps to 6 rows.
    const longLine = 'x'.repeat(60) // at width=10 → 6 wrapped rows
    const items: TranscriptItem[] = [
      { id: 'old', text: 'prev' },
      { id: 'newest', text: longLine },
    ]
    const result = selectVisibleTranscriptWindow(items, 10, 4, 0)
    expect(result.visible).toHaveLength(1)
    expect(result.visible[0]!.id).toMatch(/^newest::0-4$/)
    // First 4 rows of the 6-row wrap — 'xxxxxxxxxx' × 4.
    expect(result.visible[0]!.text.split('\n')).toHaveLength(4)
    expect(result.visible[0]!.text.startsWith('xxxxxxxxxx')).toBe(true)
  })

  it('non-live (scrolled): position-based slicing still applies (legacy behavior preserved)', () => {
    // When user explicitly scrolled up, the position-based policy
    // remains — user is navigating, not reading the newest turn.
    const items: TranscriptItem[] = [
      { id: 'a', text: '0\n1\n2\n3\n4\n5' },  // 6 lines
      { id: 'b', text: '6\n7\n8' },           // 3 lines
    ]
    // scrollOffset=2 → viewEnd=7, viewStart=4
    const result = selectVisibleTranscriptWindow(items, 80, 3, 2)
    // 'a' shows its bottom 2 lines (4,5), 'b' shows its first line (6).
    expect(result.visible).toHaveLength(2)
    expect(result.visible[0]!.id).toMatch(/^a::4-6$/)
    expect(result.visible[0]!.text).toBe('4\n5')
    expect(result.visible[1]!.id).toMatch(/^b::0-1$/)
    expect(result.visible[1]!.text).toBe('6')
  })
})

describe('live-follow scroll rules', () => {
  it('treats negative delta as scroll-away and positive delta as return-toward-live', () => {
    expect(applyTranscriptScrollDelta(0, -6)).toBe(6)
    expect(applyTranscriptScrollDelta(6, 4)).toBe(2)
    expect(applyTranscriptScrollDelta(2, 9)).toBe(0)
  })

  it('counts transcript lines using wrapped display lines', () => {
    const items = [
      { id: 'a', text: 'hello' },
      { id: 'b', text: 'x'.repeat(25) },
      { id: 'c', text: 'left\nright' },
    ]

    expect(countTranscriptLines(items, 10)).toBe(6)
  })

  it('preserves history position when new transcript lines arrive below', () => {
    expect(reconcileTranscriptScrollOffset({
      scrollOffset: 12,
      isSticky: false,
      prevTotalLines: 100,
      nextTotalLines: 107,
      prevBudgetLines: 20,
      nextBudgetLines: 20,
    })).toBe(19)
  })

  it('preserves history position when transcript budget shrinks while scrolled away', () => {
    expect(reconcileTranscriptScrollOffset({
      scrollOffset: 12,
      isSticky: false,
      prevTotalLines: 100,
      nextTotalLines: 100,
      prevBudgetLines: 20,
      nextBudgetLines: 17,
    })).toBe(15)
  })

  it('keeps sticky mode pinned at live', () => {
    expect(reconcileTranscriptScrollOffset({
      scrollOffset: 12,
      isSticky: true,
      prevTotalLines: 100,
      nextTotalLines: 120,
      prevBudgetLines: 20,
      nextBudgetLines: 10,
    })).toBe(0)
  })
})

// ─── Scroll indicator bar ───────────────────────────────────────

describe('buildScrollIndicatorBar', () => {
  const base = {
    cols: 80,
    totalLines: 100,
    budgetLines: 20,
    scrollOffset: 0,
    maxScrollOffset: 80,
    viewEndLine: 100,
    isScrolledAway: false,
    isScrollable: true,
    isLoading: false,
    newContentCount: 0,
    frame: 0,
  }

  it('shows live indicator when at bottom and scrollable', () => {
    const result = buildScrollIndicatorBar(base)
    expect(result).toContain('▶ live')
    expect(result).toContain('scroll')
    expect(result).toContain('L100/100')
  })

  it('shows minimal live when not scrollable', () => {
    const result = buildScrollIndicatorBar({ ...base, isScrollable: false, totalLines: 5, budgetLines: 20 })
    expect(result).toBe('  ▶ live')
  })

  it('shows history mode when scrolled away', () => {
    const result = buildScrollIndicatorBar({
      ...base,
      isScrolledAway: true,
      scrollOffset: 40,
      viewEndLine: 60,
    })
    expect(result).toContain('history')
    expect(result).toContain('Ctrl+↓ live')
    expect(result).toContain('60%')
    expect(result).toContain('L60/100')
  })

  it('shows animated new-content indicator when scrolled away during loading', () => {
    const result = buildScrollIndicatorBar({
      ...base,
      isScrolledAway: true,
      isLoading: true,
      scrollOffset: 40,
      viewEndLine: 60,
      newContentCount: 5,
    })
    expect(result).toContain('5 new below')
    expect(result).toContain('Ctrl+↓ live')
  })

  it('shows new content indicator with zero count during loading', () => {
    const result = buildScrollIndicatorBar({
      ...base,
      isScrolledAway: true,
      isLoading: true,
      scrollOffset: 10,
      viewEndLine: 90,
      newContentCount: 0,
    })
    expect(result).toContain('new content below')
  })

  it('keeps textual indicator focused on state and position, not a fake horizontal bar', () => {
    const result = buildScrollIndicatorBar(base)
    expect(result).not.toContain('█')
    expect(result).not.toContain('░')
    expect(result).toContain('L100/100')
  })

  it('line counter reflects actual viewport position', () => {
    const result = buildScrollIndicatorBar({
      ...base,
      scrollOffset: 50,
      viewEndLine: 50,
      isScrolledAway: true,
    })
    expect(result).toContain('L50/100')
  })
})

describe('parseSgrWheelDelta', () => {
  it('detects wheel up from plain SGR mouse report', () => {
    expect(parseSgrWheelDelta('\x1b[<64;12;9M')).toBe(1)
  })

  it('detects wheel down from plain SGR mouse report', () => {
    expect(parseSgrWheelDelta('\x1b[<65;12;9M')).toBe(-1)
  })

  it('detects modified wheel reports using upstream bitmask semantics', () => {
    expect(parseSgrWheelDelta('\x1b[<80;12;9M')).toBe(1)
    expect(parseSgrWheelDelta('\x1b[<81;12;9M')).toBe(-1)
  })

  it('ignores non-wheel mouse reports', () => {
    expect(parseSgrWheelDelta('\x1b[<0;12;9M')).toBe(0)
    expect(parseSgrWheelDelta('hello')).toBe(0)
  })
})

describe('Ink wheel input mapping', () => {
  it('maps wheel mouse reports to wheel keys without leaking text input', () => {
    const wheelUp = new InputEvent({
      kind: 'key',
      name: 'wheelup',
      sequence: '\x1b[<64;12;9M',
      raw: '\x1b[<64;12;9M',
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      super: false,
      fn: false,
      isPasted: false,
    })
    const wheelDown = new InputEvent({
      kind: 'key',
      name: 'wheeldown',
      sequence: '\x1b[<65;12;9M',
      raw: '\x1b[<65;12;9M',
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      super: false,
      fn: false,
      isPasted: false,
    })

    expect(wheelUp.key.wheelUp).toBe(true)
    expect(wheelUp.key.wheelDown).toBe(false)
    expect(wheelUp.input).toBe('')
    expect(wheelDown.key.wheelDown).toBe(true)
    expect(wheelDown.key.wheelUp).toBe(false)
    expect(wheelDown.input).toBe('')
  })

  it('re-synthesizes wheel reports when the terminal splits after ESC[', () => {
    const [firstKeys, splitState] = parseMultipleKeypresses(INITIAL_STATE, '\x1b[')
    expect(firstKeys).toHaveLength(0)

    const [secondKeys] = parseMultipleKeypresses(splitState, '<64;12;9M')
    expect(secondKeys).toHaveLength(1)
    expect(secondKeys[0]).toMatchObject({ kind: 'key', name: 'wheelup' })
  })
})

describe('selection-first transcript compatibility', () => {
  it('marks tmux wheel as not guaranteed and emits a startup notice', () => {
    const capability = getTranscriptInteractionCapability({
      TMUX: '/tmp/tmux-501/default,1234,0',
      TERM_PROGRAM: 'Apple_Terminal',
    })

    expect(capability.environment).toBe('tmux')
    expect(capability.wheelSupport).toBe('not_guaranteed')
    expect(capability.startupNotice).toContain('tmux detected')
  })

  it('marks Terminal.app direct wheel as verified', () => {
    const capability = getTranscriptInteractionCapability({
      TERM_PROGRAM: 'Apple_Terminal',
    })

    expect(capability.environment).toBe('terminal_app')
    expect(capability.wheelSupport).toBe('verified')
    expect(capability.wheelSummary).toContain('Terminal.app')
  })
})

// ─── Slash prefix detection ─────────────────────────────────────

describe('slash prefix overlay trigger', () => {
  // The handleInputChange in ink-repl.tsx uses /^\/[a-z-]*$/i to detect
  // slash command prefixes. These tests verify the regex behavior.
  const slashPrefixRe = /^\/[a-z-]*$/i

  it('matches bare /', () => {
    expect(slashPrefixRe.test('/')).toBe(true)
  })

  it('matches /mo prefix', () => {
    expect(slashPrefixRe.test('/mo')).toBe(true)
  })

  it('matches /model', () => {
    expect(slashPrefixRe.test('/model')).toBe(true)
  })

  it('matches /release-notes (hyphenated)', () => {
    expect(slashPrefixRe.test('/release-notes')).toBe(true)
  })

  it('does not match paths like /usr/bin', () => {
    expect(slashPrefixRe.test('/usr/bin')).toBe(false)
  })

  it('does not match text before slash', () => {
    expect(slashPrefixRe.test('hello /model')).toBe(false)
  })

  it('does not match slash with space', () => {
    expect(slashPrefixRe.test('/model switch')).toBe(false)
  })

  it('does not match slash with numbers', () => {
    expect(slashPrefixRe.test('/123')).toBe(false)
  })

  it('fuzzy search on slash items filters with prefix query', () => {
    const items = buildSlashPickerItems()
    const query = 'mo'
    const matches = items.filter(
      (item) => fuzzyMatch(query, `${item.label} ${item.description ?? ''}`) >= 0,
    )
    const labels = matches.map((m) => m.label)
    expect(labels).toContain('/model')
  })

  it('fuzzy search with sess prefix finds /sessions', () => {
    const items = buildSlashPickerItems()
    const query = 'sess'
    const matches = items.filter(
      (item) => fuzzyMatch(query, `${item.label} ${item.description ?? ''}`) >= 0,
    )
    const labels = matches.map((m) => m.label)
    expect(labels).toContain('/sessions')
  })
})

// ─── OC working indicator ───────────────────────────────────────

describe('buildOcLoaderFrame', () => {
  it('contains OC at every frame', () => {
    for (let frame = 0; frame < 20; frame++) {
      expect(buildOcLoaderFrame(frame)).toContain('OC')
    }
  })

  it('is not a horizontal marquee — no dot-padding that shifts OC position', () => {
    // The old animation was `···OC···` with OC sliding left-right.
    // The new animation keeps OC centered in a compact bracket frame.
    for (let frame = 0; frame < 10; frame++) {
      const result = buildOcLoaderFrame(frame)
      // Must NOT match the old pattern of variable-length dot padding
      expect(result).not.toMatch(/^·+OC·+$/)
    }
  })

  it('is compact — no wider than 8 characters', () => {
    for (let frame = 0; frame < 10; frame++) {
      expect(buildOcLoaderFrame(frame).length).toBeLessThanOrEqual(8)
    }
  })

  it('animates — at least 2 distinct frames exist in a cycle', () => {
    const frames = new Set<string>()
    for (let frame = 0; frame < 20; frame++) {
      frames.add(buildOcLoaderFrame(frame))
    }
    expect(frames.size).toBeGreaterThanOrEqual(2)
  })

  it('handles negative frame gracefully', () => {
    const result = buildOcLoaderFrame(-3)
    expect(result).toContain('OC')
  })
})

describe('buildOcWorkingIndicatorLines', () => {
  it('returns 1 line when elapsed < 5s (compact single-line panel)', () => {
    const lines = buildOcWorkingIndicatorLines({
      frame: 0,
      elapsedSeconds: 4,
      model: 'test-model',
    })
    expect(lines).toHaveLength(1)
  })

  it('returns 2 lines when elapsed >= 5s awaiting_model (adds pulse bar)', () => {
    const lines = buildOcWorkingIndicatorLines({
      frame: 0,
      elapsedSeconds: 5,
      model: 'test-model',
      phase: 'awaiting_model',
    })
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('░')
  })

  it('tool_execution does not add pulse bar even at long elapsed', () => {
    const lines = buildOcWorkingIndicatorLines({
      frame: 0,
      elapsedSeconds: 20,
      model: 'test-model',
      phase: 'tool_execution',
      activeToolName: 'bash',
    })
    expect(lines).toHaveLength(1)
  })

  it('contains OC brand, phase detail, elapsed time, and Ctrl+C hint', () => {
    const lines = buildOcWorkingIndicatorLines({
      frame: 0,
      elapsedSeconds: 12,
      model: 'test-model',
    })
    expect(lines[0]).toContain('OC')
    expect(lines[0]).toContain('12s')
    expect(lines[0]).toContain('Ctrl+C')
  })

  it('awaiting_model phase shows waiting for model', () => {
    const lines = buildOcWorkingIndicatorLines({
      frame: 0,
      elapsedSeconds: 0,
      model: 'kimi-code',
      phase: 'awaiting_model',
    })
    expect(lines[0]).toContain('Waiting for kimi-code')
  })

  it('tool_execution phase shows running tool name', () => {
    const lines = buildOcWorkingIndicatorLines({
      frame: 0,
      elapsedSeconds: 3,
      model: 'test-model',
      phase: 'tool_execution',
      activeToolName: 'bash',
    })
    expect(lines[0]).toContain('Running bash')
  })

  it('busy phase shows retrying', () => {
    const lines = buildOcWorkingIndicatorLines({
      frame: 0,
      elapsedSeconds: 1,
      model: 'test-model',
      phase: 'busy',
    })
    expect(lines[0]).toContain('Retrying')
  })

  it('custom detail overrides default phase text', () => {
    const lines = buildOcWorkingIndicatorLines({
      frame: 0,
      elapsedSeconds: 0,
      model: 'test-model',
      phase: 'awaiting_model',
      detail: 'Loading models…',
    })
    expect(lines[0]).toContain('Loading models…')
  })

  it('elapsed seconds never goes negative', () => {
    const lines = buildOcWorkingIndicatorLines({
      frame: 0,
      elapsedSeconds: -5,
      model: 'test-model',
    })
    expect(lines[0]).toContain('0s')
  })
})

// ─── Inline status line ──────────────────────────────────────────

describe('buildInlineStatusLine', () => {
  it('shows "Thinking" in first 3 seconds', () => {
    const result = buildInlineStatusLine({
      frame: 0,
      elapsedSeconds: 0,
      model: 'kimi-code',
      phase: 'awaiting_model',
    })
    expect(result).toContain('Thinking')
  })

  it('shows "reading context" between 3–8 seconds', () => {
    const result = buildInlineStatusLine({
      frame: 0,
      elapsedSeconds: 5,
      model: 'kimi-code',
      phase: 'awaiting_model',
    })
    expect(result).toContain('reading context')
  })

  it('shows model name + elapsed after 8 seconds', () => {
    const result = buildInlineStatusLine({
      frame: 0,
      elapsedSeconds: 12,
      model: 'kimi-code',
      phase: 'awaiting_model',
    })
    expect(result).toContain('kimi-code')
    expect(result).toContain('12s')
  })

  it('tool_execution phase shows tool name', () => {
    const result = buildInlineStatusLine({
      frame: 0,
      elapsedSeconds: 3,
      model: 'test-model',
      phase: 'tool_execution',
      activeToolName: 'bash',
    })
    expect(result).toContain('Running bash')
  })

  it('busy phase shows retrying', () => {
    const result = buildInlineStatusLine({
      frame: 0,
      elapsedSeconds: 1,
      model: 'test-model',
      phase: 'busy',
    })
    expect(result).toContain('Retrying')
  })

  it('custom detail overrides default phase text', () => {
    const result = buildInlineStatusLine({
      frame: 0,
      elapsedSeconds: 0,
      model: 'test-model',
      detail: 'Receiving response…',
    })
    expect(result).toContain('Receiving response')
  })

  it('contains animated spinner character', () => {
    const frames = new Set<string>()
    for (let frame = 0; frame < 20; frame++) {
      const result = buildInlineStatusLine({
        frame,
        elapsedSeconds: 5,
        model: 'test-model',
      })
      frames.add(result.charAt(0))
    }
    expect(frames.size).toBeGreaterThanOrEqual(2)
  })

  it('differs from bottom panel — no OC brand prefix', () => {
    const inline = buildInlineStatusLine({
      frame: 0,
      elapsedSeconds: 5,
      model: 'test-model',
      phase: 'awaiting_model',
    })
    const panel = buildOcWorkingIndicatorLines({
      frame: 0,
      elapsedSeconds: 5,
      model: 'test-model',
      phase: 'awaiting_model',
    })
    // Inline should NOT contain "OC" brand (just spinner + text)
    // Panel SHOULD contain "OC" brand
    expect(panel[0]).toContain('OC')
    // Inline uses bare spinner, panel uses branded "⠋ OC"
    expect(inline).not.toContain(' OC ')
  })

  it('isLoading=true with spinnerState=null shows custom detail (streaming case)', () => {
    // When spinnerState is null during loading, ink-repl passes 'Receiving response…'
    const result = buildInlineStatusLine({
      frame: 0,
      elapsedSeconds: 3,
      model: 'test-model',
      detail: 'Receiving response…',
    })
    expect(result).toContain('Receiving response')
  })

  it('detail override shows "Synthesizing final answer" verbatim', () => {
    const result = buildInlineStatusLine({
      frame: 0,
      elapsedSeconds: 2,
      model: 'minimax-m27',
      phase: 'awaiting_model',
      detail: 'Synthesizing final answer',
    })
    expect(result).toContain('Synthesizing final answer')
    expect(result).not.toContain('Thinking')
  })

  it('detail override takes precedence over awaiting_model default copy', () => {
    const result = buildInlineStatusLine({
      frame: 0,
      elapsedSeconds: 12,
      model: 'minimax-m27',
      phase: 'awaiting_model',
      detail: 'Retrying synthesis (fallback)',
    })
    expect(result).toContain('Retrying synthesis (fallback)')
    expect(result).not.toContain('minimax-m27')
  })

  // ── P0 busy-heartbeat: stallMs suffix ──
  //
  // When the task is still alive (spinner keeps animating) but no
  // concrete progress has landed recently, the status must show that
  // fact so the user can distinguish "still streaming" from "silently
  // waiting". Tested across each phase so no phase is accidentally
  // excluded from the stall visibility.

  it('does not append idle suffix when stallMs is below threshold', () => {
    const result = buildInlineStatusLine({
      frame: 0,
      elapsedSeconds: 10,
      model: 'test-model',
      phase: 'awaiting_model',
      stallMs: 500,
    })
    expect(result).not.toContain('idle')
  })

  it('appends idle suffix when stallMs exceeds 3s in awaiting_model phase', () => {
    const result = buildInlineStatusLine({
      frame: 0,
      elapsedSeconds: 10,
      model: 'test-model',
      phase: 'awaiting_model',
      stallMs: 7500,
    })
    expect(result).toContain('idle 7s')
  })

  it('appends idle suffix in tool_execution phase', () => {
    const result = buildInlineStatusLine({
      frame: 0,
      elapsedSeconds: 20,
      model: 'test-model',
      phase: 'tool_execution',
      activeToolName: 'bash',
      stallMs: 12_000,
    })
    expect(result).toContain('Running bash')
    expect(result).toContain('idle 12s')
  })

  it('appends idle suffix when a detail override is active', () => {
    const result = buildInlineStatusLine({
      frame: 0,
      elapsedSeconds: 5,
      model: 'test-model',
      detail: 'Receiving response…',
      stallMs: 4_000,
    })
    expect(result).toContain('Receiving response')
    expect(result).toContain('idle 4s')
  })

  it('omits idle suffix when stallMs is undefined (task just started)', () => {
    const result = buildInlineStatusLine({
      frame: 0,
      elapsedSeconds: 15,
      model: 'test-model',
      phase: 'awaiting_model',
    })
    expect(result).not.toContain('idle')
  })

  it('threshold is exactly 3000ms — anything under does not show idle', () => {
    const atThreshold = buildInlineStatusLine({
      frame: 0,
      elapsedSeconds: 10,
      model: 'test-model',
      phase: 'awaiting_model',
      stallMs: 2999,
    })
    expect(atThreshold).not.toContain('idle')
    const pastThreshold = buildInlineStatusLine({
      frame: 0,
      elapsedSeconds: 10,
      model: 'test-model',
      phase: 'awaiting_model',
      stallMs: 3000,
    })
    expect(pastThreshold).toContain('idle 3s')
  })
})

// ─── onNotice routing contract ─────────────────────────────────────

describe('onNotice routing (via routeConversationNotice)', () => {
  const emptyState = {
    trimCount: 0,
    nudgeCount: 0,
    repairCount: 0,
    summaryGateCount: 0,
    compactionCount: 0,
    targetedCheckCount: 0,
    synthesisCount: 0,
    fallbackSynthesisCount: 0,
    hardStopCount: 0,
    constrainedContinuationCount: 0,
  }

  it('Summary gate notices route to footer only, omit workflowPhase (preserve)', async () => {
    const { routeConversationNotice } = await import('../../src/native/loop-noise.js')
    const routed = routeConversationNotice('Summary gate: batched 4 exploratory tools', emptyState)
    expect(routed.transcriptEntry).toBeNull()
    expect(routed.footerNotice).toContain('Summary gate:')
    expect('workflowPhase' in routed).toBe(false)
    expect(routed.nextState.summaryGateCount).toBe(1)
  })

  it('Synthesis phase notices set workflowPhase = synthesizing', async () => {
    const { routeConversationNotice } = await import('../../src/native/loop-noise.js')
    const routed = routeConversationNotice('Synthesis phase: producing final answer under contract validator', emptyState)
    expect(routed.transcriptEntry).not.toBeNull()
    expect(routed.footerNotice).toContain('Synthesis phase:')
    expect(routed.workflowPhase).toBe('synthesizing')
    expect(routed.nextState.synthesisCount).toBe(1)
  })

  it('Constrained continuation notices explicitly clear workflowPhase to null', async () => {
    const { routeConversationNotice } = await import('../../src/native/loop-noise.js')
    const routed = routeConversationNotice('Constrained continuation: reopened exploration.', emptyState)
    expect(routed.transcriptEntry).not.toBeNull()
    expect(routed.footerNotice).toContain('Constrained continuation:')
    expect(routed.workflowPhase).toBeNull()
    expect(routed.nextState.constrainedContinuationCount).toBe(1)
  })
})

// ─── pseudo tool-call scrubber ──────────────────────────────────────

describe('scrubPseudoToolCall', () => {
  it('replaces a [TOOL_CALL] marker with a dim elided placeholder on first hit', () => {
    const state = { elided: false }
    const out = scrubPseudoToolCall('Let me read the file. [TOOL_CALL]{"path":"x.ts"}[/TOOL_CALL]', state)
    expect(out).toContain('[pseudo tool-call syntax elided]')
    expect(out).not.toContain('[TOOL_CALL]')
    expect(out).not.toContain('[/TOOL_CALL]')
    expect(state.elided).toBe(true)
  })

  it('elides the JSON body between [TOOL_CALL] and [/TOOL_CALL] (not just the tokens)', () => {
    // Guard against the earlier defect where only the two bracket tokens
    // were stripped, leaving the JSON argument payload visible in the
    // live pane. The paired-block matcher must consume the body too.
    const state = { elided: false }
    const out = scrubPseudoToolCall('[TOOL_CALL]{"path":"/etc/passwd","mode":"r"}[/TOOL_CALL]', state)
    expect(out).not.toContain('"path"')
    expect(out).not.toContain('/etc/passwd')
    expect(out).not.toContain('"mode"')
    expect(out).not.toContain('[TOOL_CALL]')
    expect(out).not.toContain('[/TOOL_CALL]')
    expect(out).toContain('[pseudo tool-call syntax elided]')
    expect(state.elided).toBe(true)
  })

  it('second occurrence in the same turn is silent (no repeated placeholder)', () => {
    const state = { elided: false }
    scrubPseudoToolCall('[TOOL_CALL]first[/TOOL_CALL]', state)
    const out = scrubPseudoToolCall('more text [TOOL_CALL]second[/TOOL_CALL] tail', state)
    const placeholderCount = (out.match(/pseudo tool-call syntax elided/g) ?? []).length
    expect(placeholderCount).toBe(0)
    expect(out).not.toContain('[TOOL_CALL]')
  })

  it('handles the minimax:tool_call / tool_call / invoke variants', () => {
    const cases = [
      '<minimax:tool_call>x</minimax:tool_call>',
      '<tool_call>x</tool_call>',
      '<invoke name="read"><path>x</path></invoke>',
    ]
    for (const marker of cases) {
      const state = { elided: false }
      const out = scrubPseudoToolCall(marker, state)
      expect(out).not.toContain('<')
      expect(state.elided).toBe(true)
    }
  })

  it('leaves text without pseudo markers unchanged and does not set elided', () => {
    const state = { elided: false }
    const input = 'Just a normal paragraph about [foo] and <bar> tags that are not tool-call markers.'
    const out = scrubPseudoToolCall(input, state)
    expect(out).toBe(input)
    expect(state.elided).toBe(false)
  })

  it('mentions the marker name literally (no scrub) when wrapped in backticks, since that is a legitimate quote', () => {
    // This test documents the known limitation: chunk-level regex cannot
    // distinguish backtick-wrapped legit discussion from raw pseudo syntax.
    // We accept the scrub as a best-effort visibility guard; real-machine
    // paths where the user asks about the syntax in code blocks are rare
    // compared to the much more common model-hallucinated pseudo-call case.
    const state = { elided: false }
    const out = scrubPseudoToolCall('The marker `[TOOL_CALL]` is used by the runtime.', state)
    // Known limitation: the scrub fires even here. Document it rather than engineer around it.
    expect(state.elided).toBe(true)
    expect(out).toContain('[pseudo tool-call syntax elided]')
  })
})

// ─── Assistant composition layer ────────────────────────────────────

describe('composeAssistantChunk', () => {
  function freshState() {
    return { seenAnchors: new Set<AnchorTier>(), leftover: '' }
  }

  // — 8 anchor-hit tests (one per tier × language) —

  it('line-start 结论: translates to bold', () => {
    const state = freshState()
    const out = composeAssistantChunk('结论: the loop is correct.\n', state)
    expect(out).toContain('**结论:**')
    expect(out).toContain('the loop is correct.')
    expect(state.seenAnchors.has('conclusion')).toBe(true)
  })

  it('line-start Conclusion: translates to bold', () => {
    const state = freshState()
    const out = composeAssistantChunk('Conclusion: the loop is correct.\n', state)
    expect(out).toContain('**Conclusion:**')
    expect(state.seenAnchors.has('conclusion')).toBe(true)
  })

  it('line-start 下一步: translates with arrow prefix', () => {
    const state = freshState()
    const out = composeAssistantChunk('下一步: run the tests.\n', state)
    expect(out).toContain('→ **下一步:**')
    expect(state.seenAnchors.has('next')).toBe(true)
  })

  it('line-start Next step: translates with arrow prefix (note space in anchor)', () => {
    const state = freshState()
    const out = composeAssistantChunk('Next step: run the tests.\n', state)
    expect(out).toContain('→ **Next step:**')
    expect(state.seenAnchors.has('next')).toBe(true)
  })

  it('line-start 证据: translates to blockquote', () => {
    const state = freshState()
    const out = composeAssistantChunk('证据: ink-repl.tsx:538 declares the ref.\n', state)
    expect(out).toContain('> **证据:**')
    expect(out).toContain('ink-repl.tsx:538')
    expect(state.seenAnchors.has('evidence')).toBe(true)
  })

  it('line-start Finding: translates to blockquote', () => {
    const state = freshState()
    const out = composeAssistantChunk('Finding: the ref is declared at line 538.\n', state)
    expect(out).toContain('> **Finding:**')
    expect(state.seenAnchors.has('evidence')).toBe(true)
  })

  it('line-start 风险: translates to blockquote + [!]', () => {
    const state = freshState()
    const out = composeAssistantChunk('风险: token chunks may split the anchor.\n', state)
    expect(out).toContain('> [!] **风险:**')
    expect(state.seenAnchors.has('uncertainty')).toBe(true)
  })

  it('line-start Uncertainty: translates to blockquote + [!]', () => {
    const state = freshState()
    const out = composeAssistantChunk('Uncertainty: streaming chunks may split the anchor.\n', state)
    expect(out).toContain('> [!] **Uncertainty:**')
    expect(state.seenAnchors.has('uncertainty')).toBe(true)
  })

  // — 3 anchor-rejection tests —

  it('rejects anchor in mid-sentence (no preceding sentence boundary)', () => {
    const state = freshState()
    const input = 'He draws the conclusion: the code is fine.\n'
    const out = composeAssistantChunk(input, state)
    expect(out).not.toContain('**conclusion:**')
    expect(out).not.toContain('**Conclusion:**')
    expect(state.seenAnchors.size).toBe(0)
  })

  it('matches sentence-start anchor after . and whitespace', () => {
    const state = freshState()
    const input = 'I analyzed the code. Conclusion: the loop is correct.\n'
    const out = composeAssistantChunk(input, state)
    expect(out).toContain('**Conclusion:**')
    // Anchor should have been pushed onto a new line
    expect(out).toMatch(/\n\*\*Conclusion:\*\*/)
    expect(state.seenAnchors.has('conclusion')).toBe(true)
  })

  it('rejects anchor with no whitespace after the colon', () => {
    // "Conclusion:X" (no space) is not a match; anchor requires trailing \s+
    const state = freshState()
    const out = composeAssistantChunk('Conclusion:the loop is correct.\n', state)
    expect(out).not.toContain('**Conclusion:**')
    expect(state.seenAnchors.size).toBe(0)
  })

  // — 3 fallback sentence-split tests —

  it('fallback splits Latin prose with one sentence over 80 chars', () => {
    const state = freshState()
    const longSentence = 'This is a very long sentence with many words that goes on and on and on until it reaches the threshold.'
    const shortSentence = 'This is short.'
    const input = `${longSentence} ${shortSentence}\n`
    const out = composeAssistantChunk(input, state)
    // Should have inserted a newline between the two sentences
    expect(out).toContain(`${longSentence}\n${shortSentence}`)
  })

  it('fallback passthrough when all sentences are below 80 chars', () => {
    const state = freshState()
    const input = 'Short one. Short two. Short three.\n'
    const out = composeAssistantChunk(input, state)
    // No \n inserted between sentences
    expect(out).toBe(`${input}`)
  })

  it('fallback CJK-aware threshold (40 chars) splits when Latin threshold would not', () => {
    const state = freshState()
    // s1 is 47 CJK chars including the 。 — over the 40 CJK threshold, under 80 Latin.
    // Chinese convention omits inter-sentence whitespace, so the split regex must
    // match zero-width after a CJK sentence ender (。！？).
    const s1 = '这是一个足够长的中文长句子具体包含四十七个汉字用于测试中文分句阈值是否正确生效的断句逻辑机制。'
    const s2 = '后面还有一句短的。'
    const input = `${s1}${s2}\n`
    const out = composeAssistantChunk(input, state)
    expect(out).toContain(`${s1}\n${s2}`)
  })

  // — 1 passthrough test —

  it('passthrough short prose with no anchor unchanged', () => {
    const state = freshState()
    const input = 'Just a short line with no anchor.\n'
    const out = composeAssistantChunk(input, state)
    expect(out).toBe(input)
  })

  // — 1 cross-chunk leftover test —

  it('handles anchor split across two chunks via leftover buffer', () => {
    const state = freshState()
    const out1 = composeAssistantChunk('Some analysis.\n结', state)
    // First chunk: `Some analysis.\n` is complete, `结` is leftover
    expect(out1).toContain('Some analysis.')
    expect(state.leftover).toBe('结')

    const out2 = composeAssistantChunk('论: X is true.\n', state)
    // Second chunk: leftover + chunk = `结论: X is true.\n` which has an anchor
    expect(out2).toContain('**结论:**')
    expect(out2).toContain('X is true.')
    expect(state.seenAnchors.has('conclusion')).toBe(true)
    expect(state.leftover).toBe('')
  })

  // — 1 per-turn state reset test —

  it('state reset between turns does not carry seenAnchors or leftover', () => {
    const state1 = freshState()
    composeAssistantChunk('结论: X.\n', state1)
    expect(state1.seenAnchors.has('conclusion')).toBe(true)

    // Simulate per-turn reset (what the finally block does)
    const state2 = { seenAnchors: new Set<AnchorTier>(), leftover: '' }
    expect(state2.seenAnchors.size).toBe(0)
    expect(state2.leftover).toBe('')

    // Second turn with no anchor should not report anchors
    const out = composeAssistantChunk('Just a line.\n', state2)
    expect(state2.seenAnchors.size).toBe(0)
    expect(out).toBe('Just a line.\n')
  })

  // — 1 scrubber + composer integration test —

  it('scrubber and composer compose correctly in pipeline order', () => {
    const scrubState = { elided: false }
    const composeState = freshState()

    const raw = '结论: read the file. [TOOL_CALL]{"path":"/etc"}[/TOOL_CALL]\n'
    const scrubbed = scrubPseudoToolCall(raw, scrubState)
    const composed = composeAssistantChunk(scrubbed, composeState)

    // Pseudo tool-call elided, but the anchor survived and was translated
    expect(composed).toContain('**结论:**')
    expect(composed).not.toContain('[TOOL_CALL]')
    expect(composed).not.toContain('"path"')
    expect(composed).toContain('[pseudo tool-call syntax elided]')
    expect(scrubState.elided).toBe(true)
    expect(composeState.seenAnchors.has('conclusion')).toBe(true)
  })
})

// ─── composer → markdown renderer end-to-end pipeline ────────────────
//
// Regression guards for the real-machine QA failure surfaced on 2026-04-18:
//   (a) anchor-based composition appeared as plain text in the live
//       transcript even though the helper's pure-function output was
//       correctly bolded/blockquoted.
//   (b) the final line ending mid-stream without a trailing \n
//       (classic "Risk: caveat" end-of-response shape) disappeared
//       entirely.
//
// Root cause: composeAssistantChunk buffered the trailing no-newline
// line in state.leftover. The runConversationTurn finally block never
// drained that leftover before resetting — so content that straddled
// the turn boundary was lost. These tests exercise the full pipeline
// (composer + StreamingMarkdownRenderer) including the turn-end
// synthetic-\n flush pattern the finally block now uses.

describe('composeAssistantChunk → StreamingMarkdownRenderer pipeline', () => {
  function freshState() {
    return { seenAnchors: new Set<AnchorTier>(), leftover: '' }
  }

  // Run a list of chunks through compose + renderer + turn-end flush,
  // matching the runConversationTurn onText + finally-block wiring order.
  async function runPipeline(chunks: string[]): Promise<string> {
    const { StreamingMarkdownRenderer } = await import('../../src/native/markdown.js')
    const state = freshState()
    const renderer = new StreamingMarkdownRenderer()
    let output = ''
    for (const chunk of chunks) {
      const composed = composeAssistantChunk(chunk, state)
      if (composed) output += renderer.push(composed)
    }
    // Turn-end: drain composer leftover via synthetic \n, then renderer flush
    if (state.leftover.length > 0) {
      const composerFlush = composeAssistantChunk('\n', state)
      if (composerFlush) output += renderer.push(composerFlush)
    }
    output += renderer.flush()
    return output
  }

  it('line-start Next: produces arrow prefix + bold ANSI in final transcript', async () => {
    const out = await runPipeline(['Next: run the tests.\n'])
    expect(out).toContain('→')            // arrow prefix from formatAnchor
    expect(out).toContain('Next:')        // anchor text survives
    expect(out).toContain('run the tests.')
    expect(out).toContain('\x1b[1m')      // bold ANSI from renderInline(**...**)
  })

  it('line-start Evidence: produces blockquote bar in final transcript', async () => {
    const out = await runPipeline(['Evidence: files listed here.\n'])
    expect(out).toContain('│')            // blockquote vertical bar from renderLine
    expect(out).toContain('Evidence:')    // anchor text survives
    expect(out).toContain('\x1b[1m')      // bold ANSI on the anchor
  })

  it('line-start Conclusion: produces bold in final transcript', async () => {
    const out = await runPipeline(['Conclusion: the loop is correct.\n'])
    expect(out).toContain('Conclusion:')
    expect(out).toContain('the loop is correct.')
    expect(out).toContain('\x1b[1m')      // bold ANSI
    // Conclusion tier has no arrow, no blockquote — just bold
    expect(out).not.toContain('→')
    expect(out).not.toContain('│')
  })

  it('Risk: at end-of-stream without trailing newline still reaches final output (regression guard)', async () => {
    // Simulates: model emitted "Conclusion: X\nEvidence: Y\nNext: Z\nRisk: W"
    // as its last streaming chunk, with NO trailing newline after "W". Prior
    // to the turn-end leftover drain, this last line was silently lost.
    const out = await runPipeline([
      'Conclusion: the brief summary.\nEvidence: listed files.\nNext: read X.\nRisk: the important caveat',
    ])
    expect(out).toContain('Conclusion:')
    expect(out).toContain('Evidence:')
    expect(out).toContain('Next:')
    // Critical: Risk: must survive the turn boundary
    expect(out).toContain('Risk:')
    expect(out).toContain('the important caveat')
    // And its tier-specific [!] marker must also be present
    expect(out).toContain('[!]')
  })

  it('multi-chunk stream with trailing no-newline anchor preserves tier after synthetic flush', async () => {
    // Simulates streaming where the final anchor arrives in separate chunks
    // without a final \n — exactly the chunk-boundary + end-of-stream pattern.
    const out = await runPipeline([
      'Some analysis.\n',
      '下一步: 接着读 conversation.ts',   // CJK anchor, no trailing \n
    ])
    expect(out).toContain('Some analysis.')
    expect(out).toContain('下一步:')
    expect(out).toContain('接着读 conversation.ts')
    expect(out).toContain('→')            // next tier arrow prefix
  })
})

// ─── Transcript scrollback split ───────────────────────────────────

describe('splitTranscriptForScrollback', () => {
  type Item = { id: string; text: string }
  const mk = (n: number): Item[] =>
    Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, text: `line-${i}` }))

  it('returns all items as visible when total fits the window', () => {
    const items = mk(5)
    const { scrollback, visible } = splitTranscriptForScrollback(items, 10)
    expect(scrollback).toEqual([])
    expect(visible).toEqual(items)
  })

  it('splits into scrollback + visible when total exceeds window', () => {
    const items = mk(30)
    const { scrollback, visible } = splitTranscriptForScrollback(items, 20)
    expect(scrollback).toHaveLength(10) // first 10 go to scrollback
    expect(visible).toHaveLength(20)    // last 20 visible
    expect(scrollback[0]?.id).toBe('id-0')
    expect(scrollback[9]?.id).toBe('id-9')
    expect(visible[0]?.id).toBe('id-10')
    expect(visible[19]?.id).toBe('id-29')
  })

  it('handles exactly-window-sized input as entirely visible', () => {
    const items = mk(20)
    const { scrollback, visible } = splitTranscriptForScrollback(items, 20)
    expect(scrollback).toEqual([])
    expect(visible).toEqual(items)
  })

  it('returns empty arrays on empty input', () => {
    const { scrollback, visible } = splitTranscriptForScrollback([], 20)
    expect(scrollback).toEqual([])
    expect(visible).toEqual([])
  })

  it('guards against non-positive window sizes (clamps to 1)', () => {
    const items = mk(5)
    const r0 = splitTranscriptForScrollback(items, 0)
    expect(r0.visible).toHaveLength(1)
    expect(r0.scrollback).toHaveLength(4)
    const rNeg = splitTranscriptForScrollback(items, -3)
    expect(rNeg.visible).toHaveLength(1)
    expect(rNeg.scrollback).toHaveLength(4)
  })
})
