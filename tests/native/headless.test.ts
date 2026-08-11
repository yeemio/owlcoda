import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionsDir } from '../../src/native/session.js'
import { installIsolatedOwlCodaHome } from './isolated-owlcoda-home.js'

const restoreTestHome = installIsolatedOwlCodaHome('owlcoda-headless-tests-')
const isolatedHome = process.env['OWLCODA_HOME']!
afterAll(() => {
  try {
    expect(process.env['OWLCODA_HOME']).toBe(isolatedHome)
  } finally {
    restoreTestHome()
  }
})

// Mock the conversation module
vi.mock('../../src/native/conversation.js', () => ({
  createConversation: vi.fn(({ system, model, maxTokens, tools }) => ({
    id: 'test-conv',
    system,
    model,
    maxTokens,
    tools: tools ?? [],
    turns: [],
  })),
  addUserMessage: vi.fn((conv, text) => {
    conv.turns.push({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() })
  }),
  runConversationLoop: vi.fn(async () => ({
    conversation: { turns: [] },
    finalText: 'Hello from headless!',
    iterations: 1,
  })),
  // 0.13.65: headless.ts now imports resolveDefaultMaxOutputTokens
  // for the maxTokens default. Mock it here since the test pre-mocks
  // the whole conversation.js module.
  resolveDefaultMaxOutputTokens: vi.fn(() => 32_768),
}))

// Mock the tool-defs module — override buildNativeToolDefs to a tiny tool set,
// but spread the real module so other exports stay intact. headless-approval's
// gate calls canonicalToolName(tool-defs); stripping it (the old `() => ({...})`
// factory) made that call hit `undefined` once the wrong-case safety sweep wired
// it in.
vi.mock('../../src/native/tool-defs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/native/tool-defs.js')>()),
  buildNativeToolDefs: () => [
    { name: 'bash', description: 'Native bash tool', input_schema: {} },
    { name: 'read', description: 'Native read tool', input_schema: {} },
  ],
}))

import { runHeadless } from '../../src/native/headless.js'
import { runConversationLoop, addUserMessage } from '../../src/native/conversation.js'
import { appendRuntimeEvent } from '../../src/native/runtime-events.js'
import { saveSession } from '../../src/native/session.js'

describe('runHeadless', () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>
  let stderrWrite: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runConversationLoop).mockReset()
    vi.mocked(runConversationLoop).mockResolvedValue({
      conversation: { turns: [] } as any,
      finalText: 'Hello from headless!',
      iterations: 1,
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0, requestCount: 1 },
      runtimeFailure: null,
    })
    process.env['OWLCODA_HEADLESS_RUNTIME_RESUME_RETRY_DELAY_MS'] = '0'
    delete process.env['OWLCODA_HEADLESS_RUNTIME_RESUME_RETRIES']
    delete process.env['OWLCODA_PROJECT_MAP']
    delete process.env['OWLCODA_MAX_ITERATIONS']
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string, cb?: (err?: Error | null) => void) => {
      if (typeof cb === 'function') queueMicrotask(() => cb())
      return true
    }) as never)
    stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  })

  afterEach(() => {
    delete process.env['OWLCODA_HEADLESS_RUNTIME_RESUME_RETRY_DELAY_MS']
    delete process.env['OWLCODA_HEADLESS_RUNTIME_RESUME_RETRIES']
    delete process.env['OWLCODA_PROJECT_MAP']
    delete process.env['OWLCODA_MAX_ITERATIONS']
    stdoutWrite.mockRestore()
    stderrWrite.mockRestore()
  })

  it('sends prompt to conversation loop and returns result', async () => {
    expect(getSessionsDir()).toBe(join(isolatedHome, 'sessions'))
    const result = await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello world',
    })

    expect(result.exitCode).toBe(0)
    expect(result.text).toBe('Hello from headless!')
    expect(result.iterations).toBe(1)

    expect(addUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'test-model' }),
      'Hello world',
    )

    expect(runConversationLoop).toHaveBeenCalled()
  })

  it('streams text to stdout in non-json mode', async () => {
    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
    })

    // Callbacks are set up for stdout/stderr — verify they're function-typed
    const loopCall = vi.mocked(runConversationLoop).mock.calls[0]!
    const opts = loopCall[2]
    expect(opts.callbacks?.onText).toBeTypeOf('function')
    expect(opts.callbacks?.onError).toBeTypeOf('function')
  })

  it('uses raw non-TTY stdout in non-json mode and does not print final text twice', async () => {
    const raw = '```yaml\nstatus: ok\n```\n'
    vi.mocked(runConversationLoop).mockImplementationOnce(async (_conv, _dispatcher, opts) => {
      opts.callbacks?.onText?.(raw)
      return {
        conversation: { turns: [] } as any,
        finalText: raw,
        iterations: 1,
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0, requestCount: 1 },
        runtimeFailure: null,
      }
    })

    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'emit yaml',
    })

    const chunks = stdoutWrite.mock.calls.map(c => String(c[0])).join('')
    expect(chunks).toContain(raw)
    expect(chunks.match(/status: ok/g)?.length).toBe(1)
    expect(chunks).not.toContain('\x1b[')
    expect(chunks).not.toContain('───')
    expect(chunks).not.toContain('╭')
  })

  it('treats narration-loop after emitted final content as headless partial success', async () => {
    vi.mocked(runConversationLoop).mockImplementationOnce(async (conv: any) => {
      conv.options = {
        taskState: {
          run: { status: 'blocked', lastGuardReason: 'task stuck in narration loop' },
        },
      }
      return {
        conversation: conv,
        finalText: 'drifts:\n- id: one\n',
        iterations: 3,
        stopReason: 'narration_loop',
        usage: { inputTokens: 0, outputTokens: 0, requestCount: 1 },
        runtimeFailure: null,
      }
    })

    const result = await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'emit then stop',
    })

    expect(result.exitCode).toBe(0)
    expect(result.stopReason).toBe('narration_loop')
    expect(result.taskStatus).toBe('blocked')
    expect(result.text).toContain('drifts:')
  })

  it('suppresses streaming in json mode', async () => {
    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
      json: true,
    })

    // JSON result is written to stdout
    expect(stdoutWrite).toHaveBeenCalledWith(
      expect.stringContaining('"text":"Hello from headless!"'),
      expect.any(Function),
    )

    // In JSON mode, callbacks should be empty (no streaming)
    const loopCall = vi.mocked(runConversationLoop).mock.calls[0]!
    const opts = loopCall[2]
    expect(opts.callbacks?.onText).toBeUndefined()
  })

  it('emits machine-readable progress sentinels on stderr in json mode without polluting final stdout', async () => {
    vi.mocked(runConversationLoop).mockImplementationOnce(async (_conversation: any, _dispatcher: any, opts: any) => {
      opts.callbacks.onToolProgress('bash', {
        lines: ['still running prod-eval'],
        totalLines: 42,
        totalBytes: 4096,
        elapsedMs: 1500,
      })
      return {
        conversation: { turns: [] } as any,
        finalText: 'done',
        iterations: 1,
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0, requestCount: 1 },
        runtimeFailure: null,
      }
    })

    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Long task',
      json: true,
    })

    const stdoutLines = stdoutWrite.mock.calls.map(c => String(c[0]).trim()).filter(Boolean)
    expect(stdoutLines).toHaveLength(1)
    expect(JSON.parse(stdoutLines[0]!)).toMatchObject({ text: 'done', exit_code: 0 })

    const stderrLines = stderrWrite.mock.calls.map(c => String(c[0]).trim()).filter(Boolean)
    const sentinel = stderrLines.map(line => {
      try { return JSON.parse(line) } catch { return null }
    }).find(value => value?.type === 'owlcoda.headless.progress')
    expect(sentinel).toMatchObject({
      schema_version: 1,
      tool: 'bash',
      elapsed_ms: 1500,
      total_lines: 42,
      total_bytes: 4096,
      lines: ['still running prod-eval'],
    })
  })

  it('emits Project Map runtime and dogfood acceptance evidence in json mode', async () => {
    process.env['OWLCODA_PROJECT_MAP'] = '1'
    process.env['OWLCODA_MAX_ITERATIONS'] = '4'
    vi.mocked(runConversationLoop).mockImplementationOnce(async (conversation: any, _dispatcher: any, opts: any) => {
      conversation.options = {
        projectMapPromptSummary: '<project_map>\nPackage: fixture\n</project_map>',
        projectMapSnapshot: {
          version: 1,
          createdAt: '2026-05-30T00:00:00.000Z',
          cwd: '/tmp/project',
          gitRoot: '/tmp/project',
          gitHead: 'abc123',
          packageName: 'fixture',
          packageVersion: '1.0.0',
          sourceFiles: [{ path: '/tmp/project/package.json', kind: 'package', scope: 'repo' }],
          entrypoints: [{ path: '/tmp/project/src', kind: 'source_dir', reason: 'common source directory' }],
          truthSources: [],
          evidenceSeeds: [],
          writeBoundaries: [{ path: '/tmp/project/secrets', kind: 'deny', origin: 'project_map' }],
          verificationProfiles: [{ id: 'npm-test', appliesTo: 'code_change', commands: ['npm test'], requiredBeforeDone: true }],
          freshness: {
            status: 'fresh',
            checkedAt: '2026-05-30T00:00:00.000Z',
            gitHead: 'abc123',
            sourceHashes: {},
          },
        },
      }
      opts.callbacks.onNotice('Project Map convergence: forcing tool-free synthesis.')
      opts.callbacks.onToolStart('ProjectMap', { action: 'scan' })
      opts.callbacks.onToolEnd('ProjectMap', '{"version":1}', false, 1)
      return {
        conversation,
        finalText: 'Project Map Runtime Control Plane next gap: keep dogfood acceptance observable.',
        iterations: 4,
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0, requestCount: 1 },
        runtimeFailure: null,
      }
    })

    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Use Project Map to produce a Runtime Control Plane dogfood acceptance plan.',
      json: true,
    })

    const stdoutLines = stdoutWrite.mock.calls.map(c => String(c[0]).trim()).filter(Boolean)
    const payload = JSON.parse(stdoutLines.at(-1)!)
    expect(payload.project_map_runtime).toMatchObject({
      schema_version: 1,
      enabled: true,
      snapshot_present: true,
      prompt_injected: true,
      freshness_status: 'fresh',
      git_head: 'abc123',
      package_name: 'fixture',
      package_version: '1.0.0',
      convergence_notices: ['Project Map convergence: forcing tool-free synthesis.'],
    })
    expect(payload.project_map_runtime.source_files).toEqual([
      { path: '/tmp/project/package.json', kind: 'package', scope: 'repo' },
    ])
    expect(payload.project_map_runtime.verification_profiles).toEqual([
      { id: 'npm-test', applies_to: 'code_change', commands: ['npm test'], required_before_done: true },
    ])
    expect(payload.project_map_acceptance).toMatchObject({
      schema_version: 1,
      ok: true,
      failures: [],
      max_iterations: 4,
      checks: {
        projectMapUsed: true,
        promptInjected: true,
        withinIterationBudget: true,
        completed: true,
        noUnauthorizedToolAttempts: true,
        finalAnswerOnObjective: true,
      },
    })
  })

  it('restores runtime event log when resuming a saved session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-headless-runtime-events-'))
    const previousHome = process.env['OWLCODA_HOME']
    process.env['OWLCODA_HOME'] = home
    try {
      saveSession({
        id: 'resume-runtime-events',
        system: 'saved system',
        model: 'test-model',
        maxTokens: 1024,
        tools: [],
        turns: [{
          role: 'user',
          content: [{ type: 'text', text: 'saved prompt' }],
          timestamp: Date.now(),
        }],
        options: {
          runtimeRecoveryLedger: {
            schemaVersion: 1,
            updatedAt: '2026-06-18T00:00:01.000Z',
            checkpoints: [{
              id: 'context_replacement_checkpoint-1',
              kind: 'context_replacement_checkpoint',
              generatedAt: '2026-06-18T00:00:01.000Z',
              conversationId: 'resume-runtime-events',
              disposition: 'active',
              payload: {
                schema_version: 1,
                kind: 'context_replacement_checkpoint',
                context_replacement: {
                  input_history_digest: 'sha256:test',
                  replacement_history: [],
                  reason: 'threshold',
                  window_id: 'window-1',
                  source_turn_id: 'turn-1',
                  ledger_status: 'active',
                },
              },
              inspectCommands: [],
            }],
          },
          runtimeEventLog: {
            schemaVersion: 1,
            updatedAt: '2026-06-18T00:00:01.000Z',
            nextSeq: 2,
            events: [{
              id: 'runtime_event-1',
              seq: 1,
              kind: 'checkpoint_installed',
              at: '2026-06-18T00:00:01.000Z',
              conversationId: 'resume-runtime-events',
              checkpointId: 'context_replacement_checkpoint-1',
              checkpointKind: 'context_replacement_checkpoint',
              payload: { checkpoint_kind: 'context_replacement_checkpoint' },
            }],
          },
        },
      } as any)

      vi.mocked(runConversationLoop).mockImplementationOnce(async (conversation: any) => {
        expect(conversation.options?.runtimeEventLog?.events).toHaveLength(1)
        expect(conversation.options.runtimeEventLog.events[0]).toMatchObject({
          kind: 'checkpoint_installed',
          checkpointKind: 'context_replacement_checkpoint',
        })
        const text = conversation.turns
          .flatMap((turn: any) => turn.content)
          .filter((block: any) => block.type === 'text')
          .map((block: any) => block.text)
          .join('\n')
        expect(text).toContain('continue')
        expect(text).toContain('[Runtime truth resume snapshot]')
        expect(text).toContain('context_replacement_checkpoint-1')
        return {
          conversation,
          finalText: 'resumed with runtime events',
          iterations: 1,
          stopReason: 'end_turn',
          usage: { inputTokens: 0, outputTokens: 0, requestCount: 1 },
          runtimeFailure: null,
        }
      })

      const result = await runHeadless({
        apiBaseUrl: 'http://localhost:8019',
        apiKey: 'test-key',
        model: 'test-model',
        prompt: 'continue',
        resumeSession: 'resume-runtime-events',
        json: true,
      })

      expect(result.exitCode).toBe(0)
      expect(result.resumed).toBe(true)
    } finally {
      if (previousHome === undefined) {
        delete process.env['OWLCODA_HOME']
      } else {
        process.env['OWLCODA_HOME'] = previousHome
      }
      await rm(home, { recursive: true, force: true })
    }
  })

  it('uses tool-output evidence to fail Project Map acceptance contradictions in json mode', async () => {
    process.env['OWLCODA_PROJECT_MAP'] = '1'
    process.env['OWLCODA_MAX_ITERATIONS'] = '8'
    vi.mocked(runConversationLoop).mockImplementationOnce(async (conversation: any, _dispatcher: any, opts: any) => {
      conversation.options = {
        projectMapPromptSummary: '<project_map>\nPackage: fixture\n</project_map>',
        projectMapSnapshot: {
          version: 1,
          createdAt: '2026-05-30T00:00:00.000Z',
          cwd: '/tmp/project',
          gitRoot: '/tmp/project',
          gitHead: 'abc123',
          packageName: 'fixture',
          packageVersion: '1.0.0',
          sourceFiles: [{ path: '/tmp/project/package.json', kind: 'package', scope: 'repo' }],
          entrypoints: [],
          truthSources: [],
          evidenceSeeds: [],
          writeBoundaries: [],
          verificationProfiles: [{ id: 'npm-test', appliesTo: 'code_change', commands: ['npm test'], requiredBeforeDone: true }],
          freshness: {
            status: 'fresh',
            checkedAt: '2026-05-30T00:00:00.000Z',
            gitHead: 'abc123',
            sourceHashes: {},
          },
        },
      }
      opts.callbacks.onToolStart('ProjectMap', { action: 'scan' })
      opts.callbacks.onToolEnd('ProjectMap', '{"version":1}', false, 1)
      opts.callbacks.onToolStart('read', { path: '/tmp/project/src/native/tools/task-create.ts' })
      opts.callbacks.onToolEnd(
        'read',
        'function expandProjectMapVerificationProfiles() {}\nprojectMapVerificationProfileIds\nProject Map verification profiles: npm-test',
        false,
        1,
      )
      return {
        conversation,
        finalText: [
          'Conclusion:',
          'The Project Map Runtime Control Plane declares verification profiles, but there is no lifecycle integration layer and profiles are static dead data.',
          '',
          'Evidence:',
          'The answer remains focused on Project Map Runtime Control Plane verification-profile work.',
          '',
          'Uncertainty:',
          'None for this bounded JSON check.',
          '',
          'Next:',
          'Keep the false-positive guard as the next Runtime Control Plane gate.',
        ].join('\n'),
        iterations: 4,
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0, requestCount: 1 },
        runtimeFailure: null,
      }
    })

    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Use Project Map to produce a Runtime Control Plane acceptance false-positive plan.',
      json: true,
    })

    const stdoutLines = stdoutWrite.mock.calls.map(c => String(c[0]).trim()).filter(Boolean)
    const payload = JSON.parse(stdoutLines.at(-1)!)
    expect(payload.project_map_acceptance).toMatchObject({
      ok: false,
      failures: ['final_answer_contradicts_project_map_evidence'],
      checks: {
        finalAnswerConsistentWithEvidence: false,
      },
    })
  })

  it('returns non-zero when the task loop exits through a guard stop', async () => {
    vi.mocked(runConversationLoop).mockImplementationOnce(async (conversation: any) => {
      conversation.turns.push({
        role: 'assistant',
        content: [{ type: 'text', text: 'I am still planning.' }],
        timestamp: Date.now(),
      })
      conversation.options = {
        taskState: {
          run: {
            status: 'blocked',
            lastGuardReason: 'task no-progress hard stop',
          },
        },
      }
      return {
        conversation,
        finalText: '',
        iterations: 9,
        stopReason: 'task_no_progress',
        usage: { inputTokens: 0, outputTokens: 0, requestCount: 1 },
        runtimeFailure: null,
      }
    })

    const result = await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Fix the repo',
      json: true,
    })

    expect(result.exitCode).toBe(1)
    expect(result.stopReason).toBe('task_no_progress')
    expect(result.taskStatus).toBe('blocked')
    const stdoutLines = stdoutWrite.mock.calls.map(c => String(c[0]).trim()).filter(Boolean)
    const payload = JSON.parse(stdoutLines.at(-1)!)
    expect(payload).toMatchObject({
      exit_code: 1,
      stop_reason: 'task_no_progress',
      task_status: 'blocked',
      task_guard_reason: 'task no-progress hard stop',
    })

    const stderrLines = stderrWrite.mock.calls.map(c => String(c[0]).trim()).filter(Boolean)
    const diagnostic = stderrLines.map(line => {
      try { return JSON.parse(line) } catch { return null }
    }).find(value => value?.type === 'owlcoda.headless.stop_diagnostic')
    expect(diagnostic).toMatchObject({
      schema_version: 1,
      session_id: 'test-conv',
      stop_reason: 'task_no_progress',
      task_status: 'blocked',
      task_guard_reason: 'task no-progress hard stop',
      exit_code: 1,
    })
    expect(diagnostic.recent_assistant_text).toContain('still planning')
  })

  it('truncates oversized tool outputs in json mode while keeping valid JSON', async () => {
    vi.mocked(runConversationLoop).mockImplementationOnce(async (_conversation: any, _dispatcher: any, opts: any) => {
      opts.callbacks.onToolStart('bash', { command: 'python -m pytest -vv' })
      opts.callbacks.onToolEnd('bash', `HEAD\n${'x'.repeat(25_000)}\nTAIL`)
      return {
        conversation: { turns: [] } as any,
        finalText: 'done',
        iterations: 1,
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0, requestCount: 1 },
        runtimeFailure: null,
      }
    })

    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Run tests',
      json: true,
    })

    const stdoutLines = stdoutWrite.mock.calls.map(c => String(c[0]).trim()).filter(Boolean)
    expect(stdoutLines).toHaveLength(1)
    const payload = JSON.parse(stdoutLines[0]!)
    expect(payload.tool_calls[0].output_truncated).toBe(true)
    expect(payload.tool_calls[0].output_original_chars).toBeGreaterThan(20_000)
    expect(payload.tool_calls[0].output.length).toBeLessThan(21_000)
    expect(payload.tool_calls[0].output).toContain('HEAD')
    expect(payload.tool_calls[0].output).toContain('TAIL')
  })

  it('exposes tool result metadata in json mode for lifecycle inspection', async () => {
    vi.mocked(runConversationLoop).mockImplementationOnce(async (_conversation: any, _dispatcher: any, opts: any) => {
      opts.callbacks.onToolStart('TaskOutput', { task_id: 'task-1', block: true })
      opts.callbacks.onToolEnd('TaskOutput', 'Task task-1 is incomplete: no live process handle.', false, 12, {
        retrieval_status: 'incomplete',
        long_task_lifecycle: {
          schema_version: 1,
          long_task_id: 'task:task-1',
          source: 'task_command',
          status: 'incomplete',
          supervision_state: 'lost_handle',
          terminal: false,
          can_wait: false,
          inspect_command: 'TaskOutput task_id=task-1 block=false',
          next_action: 'rerun_or_replace_command',
        },
      })
      return {
        conversation: { turns: [] } as any,
        finalText: 'Runtime snapshot captured.',
        iterations: 1,
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0, requestCount: 1 },
        runtimeFailure: null,
      }
    })

    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Inspect task lifecycle',
      json: true,
    })

    const stdoutLines = stdoutWrite.mock.calls.map(c => String(c[0]).trim()).filter(Boolean)
    expect(stdoutLines).toHaveLength(1)
    const payload = JSON.parse(stdoutLines[0]!)
    expect(payload.tool_calls[0].metadata.long_task_lifecycle).toMatchObject({
      long_task_id: 'task:task-1',
      supervision_state: 'lost_handle',
      can_wait: false,
      next_action: 'rerun_or_replace_command',
    })
  })

  it('exposes runtime synthetic intercepts in json mode', async () => {
    vi.mocked(runConversationLoop).mockImplementationOnce(async (_conversation: any, _dispatcher: any, opts: any) => {
      opts.callbacks.onNotice('[post-recovery-overrun] skipped redundant TaskUpdate: runtime recovery already resolved for task task-1 step prove-verify; requested stepStatus="completed" is redundant for a clean recovery checkpoint.')
      opts.callbacks.onNotice('[long-task-wait-policy] skipped Sleep: runtime wait policy for task:task-1 is strategy=runtime_await; use LongTaskAwait longTaskId=task:task-1 timeoutMs=5000 instead.')
      return {
        conversation: { turns: [] } as any,
        finalText: 'Recovery ledger: Clean, all checkpoints resolved.',
        iterations: 1,
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0, requestCount: 1 },
        runtimeFailure: null,
      }
    })

    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'same-batch recovery probe',
      json: true,
    })

    const stdoutLines = stdoutWrite.mock.calls.map(c => String(c[0]).trim()).filter(Boolean)
    expect(stdoutLines).toHaveLength(1)
    const payload = JSON.parse(stdoutLines[0]!)
    expect(payload.runtime_intercepts).toEqual([{
      kind: 'post_recovery_overrun',
      message: '[post-recovery-overrun] skipped redundant TaskUpdate: runtime recovery already resolved for task task-1 step prove-verify; requested stepStatus="completed" is redundant for a clean recovery checkpoint.',
    }, {
      kind: 'long_task_wait_policy',
      message: '[long-task-wait-policy] skipped Sleep: runtime wait policy for task:task-1 is strategy=runtime_await; use LongTaskAwait longTaskId=task:task-1 timeoutMs=5000 instead.',
    }])
  })

  it('exposes runtime event interventions in json mode even without notice text', async () => {
    vi.mocked(runConversationLoop).mockImplementationOnce(async (conversation: any) => {
      appendRuntimeEvent(conversation, {
        kind: 'runtime_intervention',
        at: '2026-06-19T10:00:00.000Z',
        payload: {
          intervention_kind: 'long_task_wait_policy',
          action: 'skipped_tool_use',
          tool_use_id: 'toolu-wait-1',
          tool_name: 'Sleep',
          long_task_id: 'task:task-1',
          wait_strategy: 'runtime_await',
          stop_polling: true,
          next_check_command: 'LongTaskAwait longTaskId=task:task-1 timeoutMs=5000',
          reason: 'runtime owns long-task lifecycle waiting',
        },
      })
      return {
        conversation: { turns: [] } as any,
        finalText: 'Runtime-owned wait policy preserved.',
        iterations: 1,
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0, requestCount: 1 },
        runtimeFailure: null,
      }
    })

    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'same-batch recovery probe',
      json: true,
    })

    const stdoutLines = stdoutWrite.mock.calls.map(c => String(c[0]).trim()).filter(Boolean)
    expect(stdoutLines).toHaveLength(1)
    const payload = JSON.parse(stdoutLines[0]!)
    expect(payload.runtime_intercepts).toEqual([{
      kind: 'long_task_wait_policy',
      source: 'runtime_event_log',
      event_id: 'runtime_event-1',
      seq: 1,
      at: '2026-06-19T10:00:00.000Z',
      action: 'skipped_tool_use',
      tool_use_id: 'toolu-wait-1',
      tool_name: 'Sleep',
      long_task_id: 'task:task-1',
      wait_strategy: 'runtime_await',
      stop_polling: true,
      next_check_command: 'LongTaskAwait longTaskId=task:task-1 timeoutMs=5000',
      reason: 'runtime owns long-task lifecycle waiting',
    }])
  })

  it('waits for json stdout flush before returning', async () => {
    let flush: (() => void) | null = null
    stdoutWrite.mockImplementation(((chunk: string, cb?: (err?: Error | null) => void) => {
      if (typeof cb === 'function') {
        flush = () => cb()
      }
      return false
    }) as never)

    let settled = false
    const pending = runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
      json: true,
    }).then((result) => {
      settled = true
      return result
    })

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    expect(flush).toBeTypeOf('function')
    flush?.()

    const result = await pending
    expect(result.exitCode).toBe(0)
    expect(settled).toBe(true)
  })

  it('waits for json stdout callback even when write returns true', async () => {
    let flush: (() => void) | null = null
    stdoutWrite.mockImplementation(((chunk: string, cb?: (err?: Error | null) => void) => {
      if (typeof cb === 'function') {
        flush = () => cb()
      }
      return true
    }) as never)

    let settled = false
    const pending = runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
      json: true,
    }).then((result) => {
      settled = true
      return result
    })

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    expect(flush).toBeTypeOf('function')
    flush?.()

    const result = await pending
    expect(result.exitCode).toBe(0)
    expect(settled).toBe(true)
  })

  it('handles errors gracefully', async () => {
    vi.mocked(runConversationLoop).mockRejectedValueOnce(new Error('connection refused'))

    const result = await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
    })

    expect(result.exitCode).toBe(1)
    expect(result.text).toBe('')
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining('connection refused'),
    )
  })

  it('automatically continues the same conversation after a retryable runtime failure', async () => {
    vi.mocked(runConversationLoop)
      .mockResolvedValueOnce({
        conversation: { turns: [] } as any,
        finalText: '',
        iterations: 2,
        stopReason: null,
        usage: { inputTokens: 0, outputTokens: 0, requestCount: 1 },
        runtimeFailure: {
          kind: 'provider_error',
          phase: 'tool_continuation',
          message: 'Server shutting down',
          retryable: true,
        },
      })
      .mockResolvedValueOnce({
        conversation: { turns: [] } as any,
        finalText: 'Recovered and finished',
        iterations: 3,
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0, requestCount: 1 },
        runtimeFailure: null,
      })

    const result = await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Do a long task',
    })

    expect(result.exitCode).toBe(0)
    expect(result.text).toBe('Recovered and finished')
    expect(result.iterations).toBe(5)
    expect(result.runtimeRetries).toBe(1)
    expect(runConversationLoop).toHaveBeenCalledTimes(2)
    expect(runConversationLoop.mock.calls[1]![0]).toBe(runConversationLoop.mock.calls[0]![0])
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('Continuing automatically'))
  })

  it('exits with preserved session details after runtime resume retries are exhausted', async () => {
    process.env['OWLCODA_HEADLESS_RUNTIME_RESUME_RETRIES'] = '1'
    vi.mocked(runConversationLoop).mockResolvedValue({
      conversation: { id: 'test-conv', model: 'test-model', turns: [] } as any,
      finalText: '',
      iterations: 1,
      stopReason: null,
      usage: { inputTokens: 0, outputTokens: 0, requestCount: 1 },
      runtimeFailure: {
        kind: 'provider_error',
        phase: 'continuation',
        message: 'provider unavailable',
        retryable: true,
      },
    })

    const result = await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Do a long task',
      json: true,
    })

    expect(result.exitCode).toBe(1)
    expect(result.runtimeRetries).toBe(1)
    expect(runConversationLoop).toHaveBeenCalledTimes(2)
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('"runtime_failure"'), expect.any(Function))
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('Runtime resume retries exhausted'), expect.any(Function))
    const stdoutLines = stdoutWrite.mock.calls.map(c => String(c[0]).trim()).filter(Boolean)
    const payload = JSON.parse(stdoutLines[0]!)
    expect(payload.runtime_intercepts).toEqual([expect.objectContaining({
      kind: 'runtime_auto_retry_suppression',
      source: 'runtime_event_log',
      action: 'stopped_after_retry_limit',
      auto_retry_surface: 'headless_runtime_resume',
      suppression_reason: 'retry_limit_exhausted',
      failure_kind: 'provider_error',
      failure_phase: 'continuation',
      retryable: true,
      runtime_retries: 1,
      retry_limit: '1',
    })])
  })

  it('does not automatically continue timeout runtime failures', async () => {
    vi.mocked(runConversationLoop).mockResolvedValueOnce({
      conversation: { id: 'test-conv', model: 'test-model', turns: [] } as any,
      finalText: '',
      iterations: 1,
      stopReason: null,
      usage: { inputTokens: 0, outputTokens: 0, requestCount: 1 },
      runtimeFailure: {
        kind: 'timeout',
        phase: 'request',
        message: 'request timed out',
        retryable: true,
      },
    })

    const result = await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Do a long task',
      json: true,
    })

    expect(result.exitCode).toBe(1)
    expect(result.runtimeRetries).toBe(0)
    expect(runConversationLoop).toHaveBeenCalledTimes(1)
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('Automatic runtime resume suppressed for timeout'), expect.any(Function))
    const stdoutLines = stdoutWrite.mock.calls.map(c => String(c[0]).trim()).filter(Boolean)
    const payload = JSON.parse(stdoutLines[0]!)
    expect(payload.runtime_intercepts).toEqual([expect.objectContaining({
      kind: 'runtime_auto_retry_suppression',
      source: 'runtime_event_log',
      action: 'suppressed_auto_resume',
      auto_retry_surface: 'headless_runtime_resume',
      suppression_reason: 'failure_kind_suppressed',
      failure_kind: 'timeout',
      failure_phase: 'request',
      retryable: true,
      runtime_retries: 0,
      retry_limit: '8',
    })])
  })

  it('outputs JSON error in json mode', async () => {
    vi.mocked(runConversationLoop).mockRejectedValueOnce(new Error('timeout'))

    const result = await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
      json: true,
    })

    expect(result.exitCode).toBe(1)
    expect(stdoutWrite).toHaveBeenCalledWith(
      expect.stringContaining('"error":"timeout"'),
      expect.any(Function),
    )
  })

  it('uses custom system prompt with headless policy context appended', async () => {
    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
      systemPrompt: 'You are a cat.',
      autoApprove: true,
      allowTools: ['read', 'write'],
      denyTools: ['bash'],
    })

    const loopCall = vi.mocked(runConversationLoop).mock.calls[0]!
    const conversation = loopCall[0]
    expect(conversation.system).toContain('You are a cat.')
    expect(conversation.system).toContain('[Runtime headless approval policy]')
    expect(conversation.system).toContain('auto-approve-task-contract-writes')
    expect(conversation.system).toContain('Tool allowlist: read, write')
    expect(conversation.system).toContain('Tool denylist: bash')
  })

  it('narrows advertised tools when headless allowTools is explicit', async () => {
    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Read only',
      json: true,
      allowTools: ['read', 'bash'],
      denyTools: ['bash'],
    })

    const loopCall = vi.mocked(runConversationLoop).mock.calls[0]!
    const conversation = loopCall[0]
    expect(conversation.tools.map((tool: { name: string }) => tool.name)).toEqual(['read'])
  })

  it('respects maxTokens option', async () => {
    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
      maxTokens: 8192,
    })

    const loopCall = vi.mocked(runConversationLoop).mock.calls[0]!
    const conversation = loopCall[0]
    expect(conversation.maxTokens).toBe(8192)
  })

  // ─── Issue #1: headless approval gate ────────────────────────────────────

  it('installs onToolApproval in non-json mode (so unsafe tools cannot bypass approval)', async () => {
    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
    })
    const loopCall = vi.mocked(runConversationLoop).mock.calls[0]!
    const opts = loopCall[2]
    expect(opts.callbacks?.onToolApproval).toBeTypeOf('function')
  })

  it('installs onToolApproval in json mode (regression for issue #1 — was missing)', async () => {
    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
      json: true,
    })
    const loopCall = vi.mocked(runConversationLoop).mock.calls[0]!
    const opts = loopCall[2]
    expect(opts.callbacks?.onToolApproval).toBeTypeOf('function')
  })

  it('installs onUserQuestion in json mode so AskUserQuestion cannot block stdin', async () => {
    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
      json: true,
    })
    const callbacks = vi.mocked(runConversationLoop).mock.calls[0]![2].callbacks!
    expect(callbacks.onUserQuestion).toBeTypeOf('function')
    await expect(callbacks.onUserQuestion!('AskUserQuestion', 'Continue?', {
      options: [{ label: 'Yes' }, { label: 'No' }],
    })).resolves.toBe('')
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('Tool AskUserQuestion requested user input'))
  })

  it('installed approval callback denies unsafe tools without autoApprove', async () => {
    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
    })
    const cb = vi.mocked(runConversationLoop).mock.calls[0]![2].callbacks!.onToolApproval!
    expect(await cb('write', { path: '/tmp/x' })).toBe(false)
    expect(await cb('edit', { path: '/tmp/x' })).toBe(false)
    expect(await cb('NotebookEdit', { notebook_path: '/tmp/x.ipynb' })).toBe(false)
    expect(await cb('bash', { command: 'rm -rf /' })).toBe(false)
    expect(await cb('AskUserQuestion', { question: 'Continue?' })).toBe(false)
    // Read-only tools must remain low-friction.
    expect(await cb('read', { path: '/tmp/x' })).toBe(true)
    expect(await cb('grep', { pattern: 'foo' })).toBe(true)
  })

  it('installed approval callback does not yolo dangerous bash when autoApprove=true', async () => {
    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
      autoApprove: true,
    })
    const cb = vi.mocked(runConversationLoop).mock.calls[0]![2].callbacks!.onToolApproval!
    expect(await cb('write', { path: '/tmp/x' })).toBe(false)
    expect(await cb('bash', { command: 'echo hi' })).toBe(true)
    expect(await cb('bash', { command: 'rm -rf /tmp/x' })).toBe(false)
  })

  it('result and JSON output expose the approval policy', async () => {
    const result = await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
      json: true,
    })
    expect(result.approvalPolicy).toBe('deny-unsafe-without-approval')
    expect(stdoutWrite).toHaveBeenCalledWith(
      expect.stringContaining('"approval_policy":"deny-unsafe-without-approval"'),
      expect.any(Function),
    )

    const result2 = await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
      json: true,
      autoApprove: true,
    })
    expect(result2.approvalPolicy).toBe('auto-approve-task-contract-writes')
  })

  it('records denials and surfaces them in the result', async () => {
    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
    })
    const cb = vi.mocked(runConversationLoop).mock.calls[0]![2].callbacks!.onToolApproval!
    await cb('write', { path: '/tmp/x' })
    await cb('read', { path: '/tmp/x' })
    await cb('bash', { command: 'pwd' })          // safe-readonly — allowed under P1 classifier
    await cb('bash', { command: 'rm -rf /tmp/y' }) // dangerous — denied
    // We can't easily re-read the headless result here (it's closed over the
    // call we already returned from), but the stderr-write side effect for
    // each denial is observable.
    const stderrCalls = stderrWrite.mock.calls.map(c => String(c[0]))
    const denialMessages = stderrCalls.filter(s => s.includes('denied by headless approval policy'))
    expect(denialMessages.length).toBeGreaterThanOrEqual(2)
    expect(denialMessages.some(m => m.includes('write'))).toBe(true)
    expect(denialMessages.some(m => m.includes('bash'))).toBe(true)
    // P1 issue #2: the structured bash-risk detail is covered by
    // tests/native/headless-approval.test.ts and serializeDenials in
    // the JSON output. Stderr-side rendering of risk=<level> is a UX
    // nicety subject to banner-box wrapping; not asserted here to avoid
    // brittleness.
  })
})
