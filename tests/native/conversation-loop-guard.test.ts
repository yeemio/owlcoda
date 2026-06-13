import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolDispatcher } from '../../src/native/dispatch.js'
import {
  addUserMessage,
  buildToolAttempt,
  createConversation,
  detectToolLoop,
  recordCrossTurnFailureClass,
  runConversationLoop,
} from '../../src/native/conversation.js'
import { buildToolDef } from '../../src/native/protocol/request.js'
import { shouldScheduleRuntimeAutoRetry } from '../../src/native/repl-shared.js'
import { ensureTaskExecutionState } from '../../src/native/task-state.js'
import { recordReadAndBuildNudge } from '../../src/native/tools/read.js'
import { createTask, resetTaskStore, updateTaskStep } from '../../src/native/tools/task-store.js'
import { createTaskUpdateTool } from '../../src/native/tools/task-update.js'

// 2026-06-13 kimi-code dogfood: ReadMcpResource failed ~8× with a different
// uri each call (so signature/intentKey never repeated) spread across 46
// iterations (so no 3 landed in the 24-attempt window). The windowed
// detectors all missed it; tokens burned. The cross-turn ledger keys on
// (tool, failureCategory) — the only signal that aggregates arg-varying
// failures — and counts across the whole run, resetting when the tool
// genuinely succeeds.
describe('cross-turn failure-class accumulation (loop guard)', () => {
  const NEXT = (uri: string) =>
    buildToolAttempt('ReadMcpResource', { server_name: 'tools', uri }, false)

  function failAttempt(uri: string) {
    return buildToolAttempt(
      'ReadMcpResource',
      { server_name: 'tools', uri },
      true,
      { failureCategory: 'mcp:not-connected' },
    )
  }

  it('stops re-entering a tool that has failed the same class 5× across turns', () => {
    const ledger = new Map<string, number>()
    // 5 failures, each a DIFFERENT uri, far apart (empty windowed attempts).
    for (let i = 0; i < 5; i++) {
      recordCrossTurnFailureClass(ledger, failAttempt(`mcp://resource-${i}`))
    }
    // Windowed attempts empty → only the cross-turn branch can fire.
    const loopError = detectToolLoop([], NEXT('mcp://resource-6'), ledger)
    expect(loopError).toBeTruthy()
    expect(loopError).toMatch(/cumulative|across turns/i)
    expect(loopError).toMatch(/ReadMcpResource/)
  })

  it('does not fire below the cumulative threshold', () => {
    const ledger = new Map<string, number>()
    for (let i = 0; i < 4; i++) {
      recordCrossTurnFailureClass(ledger, failAttempt(`mcp://r-${i}`))
    }
    expect(detectToolLoop([], NEXT('mcp://r-5'), ledger)).toBeNull()
  })

  it('a genuine success of the tool resets its accumulated failure classes', () => {
    const ledger = new Map<string, number>()
    for (let i = 0; i < 4; i++) {
      recordCrossTurnFailureClass(ledger, failAttempt(`mcp://r-${i}`))
    }
    // Clean success (no failureCategory) → progress → reset that tool.
    recordCrossTurnFailureClass(
      ledger,
      buildToolAttempt('ReadMcpResource', { server_name: 'tools', uri: 'mcp://ok' }, false),
    )
    for (let i = 0; i < 4; i++) {
      recordCrossTurnFailureClass(ledger, failAttempt(`mcp://s-${i}`))
    }
    // 4 (post-reset) < 5 → still no loop.
    expect(detectToolLoop([], NEXT('mcp://s-5'), ledger)).toBeNull()
  })

  it('does not block a DIFFERENT tool when one tool is stuck', () => {
    const ledger = new Map<string, number>()
    for (let i = 0; i < 6; i++) {
      recordCrossTurnFailureClass(ledger, failAttempt(`mcp://r-${i}`))
    }
    // Next attempt is a Read, not the stuck ReadMcpResource → allowed.
    const next = buildToolAttempt('read', { path: '/tmp/x.ts' }, false)
    expect(detectToolLoop([], next, ledger)).toBeNull()
  })

  it('a clean success of a DIFFERENT tool does not reset the stuck tool', () => {
    const ledger = new Map<string, number>()
    for (let i = 0; i < 5; i++) {
      recordCrossTurnFailureClass(ledger, failAttempt(`mcp://r-${i}`))
    }
    recordCrossTurnFailureClass(
      ledger,
      buildToolAttempt('read', { path: '/tmp/x.ts' }, false),
    )
    // ReadMcpResource still at 5 → re-entering it still trips.
    expect(detectToolLoop([], NEXT('mcp://r-6'), ledger)).toBeTruthy()
  })
})

function toolUseResponse(
  toolName: string,
  toolId: string,
  input: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify({
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'tool_use', id: toolId, name: toolName, input }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function textResponse(text: string): Response {
  return new Response(JSON.stringify({
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function gateV2EnabledForTest(): boolean {
  const value = process.env['OWLCODA_GATE_V2']
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

function contentResponse(
  content: Array<Record<string, unknown>>,
  stopReason: 'end_turn' | 'tool_use' = 'end_turn',
): Response {
  return new Response(JSON.stringify({
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function failedArtifactVerification(artifactPath = '/tmp/deck.html'): Record<string, unknown> {
  return {
    packId: 'html_deck',
    status: 'failed',
    passed: false,
    artifactPath,
    checkedAt: '2026-05-16T00:00:00.000Z',
    checks: [
      {
        checkId: 'section_count',
        passed: false,
        severity: 'error',
        detail: 'expected 46 sections, got 45',
      },
    ],
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('native conversation free-mode long task loop policy', () => {
  beforeEach(() => {
    delete process.env['OWLCODA_AGENTIC_MODE']
    // Free-mode tests historically opted *out* of the loop guard via
    // OWLCODA_AGENTIC_MODE staying unset. Since 0.13.26 the loop guard is
    // independent and ON by default — the only way to keep the original
    // "let a long failing chain run" semantics is the explicit opt-out
    // env var. The cost-burn protection (default-ON) gets its own
    // dedicated suite below.
    process.env['OWLCODA_LOOP_GUARD'] = 'off'
  })

  afterEach(() => {
    delete process.env['OWLCODA_AGENTIC_MODE']
    delete process.env['OWLCODA_LOOP_GUARD']
  })

  it('does not hard-stop repeated failing bash attempts in default free mode', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Keep diagnosing a long task until you can report the exact blocker.')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'bash',
      description: 'test bash',
      async execute(input: any) {
        return { output: `bash failed ${String(input['command'] ?? '')}`, isError: true }
      },
    })

    const responses = [
      toolUseResponse('bash', 'tool-1', { cwd: '/tmp/project', command: 'cd /tmp/project && python3 tests/smoke.py /tmp/run-1234.log' }),
      toolUseResponse('bash', 'tool-2', { cwd: '/tmp/project', command: 'cd /tmp/project && python3 tests/smoke.py /tmp/run-5678.log' }),
      toolUseResponse('bash', 'tool-3', { cwd: '/tmp/project', command: 'cd /tmp/project && python3 tests/smoke.py /tmp/run-9012.log' }),
      toolUseResponse('bash', 'tool-4', { cwd: '/tmp/project', command: 'cd /tmp/project && python3 tests/smoke.py /tmp/run-3456.log' }),
      textResponse('I isolated the blocker and will stop here with the evidence.'),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(error) {
          errors.push(error)
        },
      },
    })

    expect(errors).toHaveLength(0)
    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toContain('I isolated the blocker')
  })

  it('does not hard-stop long successful no-output verification chains in default free mode', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Run the whole verification chain and only report when complete.')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'bash',
      description: 'test bash',
      async execute() {
        return { output: '', isError: false }
      },
    })

    const responses = [
      ...Array.from({ length: 24 }, (_, index) =>
        toolUseResponse('bash', `tool-${index + 1}`, {
          cwd: '/tmp/project',
          command: `./verify-step-${index + 1}.sh`,
        }),
      ),
      textResponse('verification chain complete'),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(error) {
          errors.push(error)
        },
      },
    })

    expect(errors).toHaveLength(0)
    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toBe('verification chain complete')
  })

  it('does not intercept long ssh-wrapper diagnostic chains with mixed outcomes (0.14.10 regression)', async () => {
    // Field bug 2026-05-11: model ran ~24 ssh commands during an aliyun
    // smoke session, several failed (compose timeout, docker build retry,
    // env not yet loaded). Each command shared the same ssh wrapper
    // prefix, which collapsed bash signatures and tripped the soft loop
    // intercept twice mid-task. The intercept's tool_result preamble was
    // read as a stop signal and the model derailed into A/B/C meta-dialog
    // both times. Post-fix: bash is exempt from intent/window heuristics;
    // exact call-level dedup still exists, but these commands differ and
    // must run to completion.
    process.env['OWLCODA_LOOP_GUARD'] = 'on'
    process.env['OWLCODA_LOOP_INTERCEPT'] = 'soft'

    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Drive the aliyun smoke chain to completion')

    const dispatcher = new ToolDispatcher()
    let callIndex = 0
    dispatcher.register({
      name: 'bash',
      description: 'test bash',
      async execute(input: any) {
        // Half of the calls report isError, mimicking real diagnostic
        // chains where intermittent failures still represent progress.
        const fail = callIndex % 2 === 0
        callIndex += 1
        return { output: `bash ${fail ? 'failed' : 'ok'}: ${String(input['command'] ?? '')}`, isError: fail }
      },
    })

    const sshPrefix = "ssh -o ConnectTimeout=10 aliyun-sieracclaw '"
    const remoteCmds = [
      'docker compose ps',
      'docker compose -f deploy/p0.yml up -d',
      'docker logs sierac-mes-middleware-p0 --tail 80',
      'curl -fsS http://127.0.0.1:8001/mes/health',
      'docker compose -f deploy/p0.yml restart middleware',
      'docker compose ps --format json',
      "grep MES_CLIENT_KEY /home/publicuser/sieracMes-AI/deploy/env/mes.env",
      'docker compose -f deploy/p0.yml exec middleware env',
      'curl -fsS http://127.0.0.1:8001/mes/admin/stats -H "X-MES-Client-Key: ..."',
      'docker compose -f deploy/p0.yml stop middleware',
      'docker compose -f deploy/p0.yml start middleware',
      'curl -fsS http://127.0.0.1:8001/mes/health',
    ]

    const responses = [
      ...remoteCmds.map((cmd, index) =>
        toolUseResponse('bash', `tool-${index + 1}`, {
          cwd: '/Users/publicuser/AI/project/sieracMes-AI',
          command: `${sshPrefix}${cmd}'`,
        }),
      ),
      textResponse('aliyun smoke chain complete, blocker identified'),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const notices: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(error) { errors.push(error) },
        onNotice(notice) { notices.push(notice) },
      },
    })

    expect(errors).toHaveLength(0)
    expect(notices.find((n) => n.includes('Loop intercept'))).toBeUndefined()
    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toContain('aliyun smoke chain complete')
  })
})

describe('native conversation tool loop guard', () => {
  // These tests exercise the STRICT agentic guards (convergence → synthesis,
  // fan-out summary gate, tool-only nudge after N turns, etc.). From 0.12.8
  // the loop runs in FREE mode by default — the user is the only authority
  // on when to stop. Strict mode is opt-in via OWLCODA_AGENTIC_MODE=strict,
  // so this suite sets the env var to keep coverage of the guard logic.
  // 0.13.55: this suite preserves the legacy "loop detect → hard terminate"
  // semantics it was originally written against. Soft intercept (the new
  // default) is covered by its own suite below.
  beforeEach(() => {
    process.env['OWLCODA_AGENTIC_MODE'] = 'strict'
    process.env['OWLCODA_LOOP_INTERCEPT'] = 'hard'
  })
  afterEach(() => {
    delete process.env['OWLCODA_AGENTIC_MODE']
    delete process.env['OWLCODA_LOOP_INTERCEPT']
  })

  it('stops repeated read/search oscillation before another tool_result is appended', async () => {
    const conv = createConversation({
      system: 'test',
      model: 'test-model',
      tools: [buildToolDef('read', 'test read', {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      })],
    })
    addUserMessage(conv, 'Find and inspect the file')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(input: any) {
        return { output: `read ${String(input['path'] ?? '')}`, isError: false }
      },
    })
    dispatcher.register({
      name: 'grep',
      description: 'test grep',
      async execute(input: any) {
        return { output: `grep ${String(input['pattern'] ?? '')}`, isError: false }
      },
    })

    const responses = [
      toolUseResponse('read', 'tool-1', { path: '/tmp/demo.ts' }),
      toolUseResponse('grep', 'tool-2', { path: '/tmp/demo.ts', pattern: 'foo' }),
      toolUseResponse('read', 'tool-3', { path: '/tmp/demo.ts' }),
      toolUseResponse('grep', 'tool-4', { path: '/tmp/demo.ts', pattern: 'foo' }),
      toolUseResponse('read', 'tool-5', { path: '/tmp/demo.ts' }),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(error) {
          errors.push(error)
        },
      },
    })

    expect(errors.at(-1)).toContain('repeated read/search attempts')
    expect(result.stopReason).toBe('tool_loop')
    // closePendingToolUse now pushes a user turn with synthetic tool_results
    // so the conversation is well-formed. Last turn is user, not assistant.
    expect(result.conversation.turns.at(-1)?.role).toBe('user')
  })

  it('stops repeated read/update oscillation before another tool_result is appended', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Read and fix the file')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(input: any) {
        return { output: `read ${String(input['path'] ?? '')}`, isError: false }
      },
    })
    dispatcher.register({
      name: 'edit',
      description: 'test edit',
      async execute(input: any) {
        return { output: `edit ${String(input['path'] ?? '')}`, isError: true }
      },
    })

    // 0.13.62: edit calls now include schema-complete input so this
    // test exercises the LOOP GUARD path (not the new schema-fail
    // short-circuit which would fire first on `edit({path})`).
    const responses = [
      toolUseResponse('read', 'tool-1', { path: '/tmp/demo.ts' }),
      toolUseResponse('edit', 'tool-2', { path: '/tmp/demo.ts', oldStr: 'foo', newStr: 'bar' }),
      toolUseResponse('read', 'tool-3', { path: '/tmp/demo.ts' }),
      toolUseResponse('edit', 'tool-4', { path: '/tmp/demo.ts', oldStr: 'foo', newStr: 'bar' }),
      toolUseResponse('read', 'tool-5', { path: '/tmp/demo.ts' }),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(error) {
          errors.push(error)
        },
      },
    })

    expect(errors.at(-1)).toContain('repeated read/update attempts')
    expect(result.stopReason).toBe('tool_loop')
    // closePendingToolUse now pushes a user turn with synthetic tool_results
    // so the conversation is well-formed. Last turn is user, not assistant.
    expect(result.conversation.turns.at(-1)?.role).toBe('user')
  })

  it('stops repeated failing updates on the same file even when edit payloads change', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Keep trying to fix the same file')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'edit',
      description: 'test edit',
      async execute(input: any) {
        return { output: `edit failed ${String(input['path'] ?? '')}`, isError: true }
      },
    })

    const responses = [
      toolUseResponse('edit', 'tool-1', { path: '/tmp/demo.ts', oldStr: 'alpha', newStr: 'beta' }),
      toolUseResponse('edit', 'tool-2', { path: '/tmp/demo.ts', oldStr: 'beta', newStr: 'gamma' }),
      toolUseResponse('edit', 'tool-3', { path: '/tmp/demo.ts', oldStr: 'gamma', newStr: 'delta' }),
      toolUseResponse('edit', 'tool-4', { path: '/tmp/demo.ts', oldStr: 'delta', newStr: 'epsilon' }),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(error) {
          errors.push(error)
        },
      },
    })

    expect(errors.at(-1)).toContain('repeated failing update attempts')
    expect(result.stopReason).toBe('tool_loop')
  })

  it('allows multiple different edits on the same file', async () => {
    // Real workflow: one file often needs several distinct edits in sequence.
    // Guard should not kill progress just because the path repeats.
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Fix the file in multiple passes')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'edit',
      description: 'test edit',
      async execute(input: any) {
        return { output: `edited ${String(input['path'] ?? '')}`, isError: false }
      },
    })

    const endResponse = new Response(JSON.stringify({
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })

    // 4 distinct edits on the same path → still allowed; final text response ends cleanly
    const responses = [
      toolUseResponse('edit', 'tool-1', { path: '/tmp/demo.ts', oldStr: 'alpha', newStr: 'beta' }),
      toolUseResponse('edit', 'tool-2', { path: '/tmp/demo.ts', oldStr: 'beta', newStr: 'gamma' }),
      toolUseResponse('edit', 'tool-3', { path: '/tmp/demo.ts', oldStr: 'gamma', newStr: 'delta' }),
      toolUseResponse('edit', 'tool-4', { path: '/tmp/demo.ts', oldStr: 'delta', newStr: 'epsilon' }),
      endResponse,
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(errors).toHaveLength(0)
    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toBe('done')
  })

  it('allows varied failing bash attempts in strict hard mode', async () => {
    // Progress-signal v2 keeps bash exempt from intent/window heuristics,
    // but exact call-level failure dedup is active. These commands differ
    // materially, so they must not collapse into one loop signature.
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Keep rerunning the same failing smoke command')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'bash',
      description: 'test bash',
      async execute(input: any) {
        return { output: `bash failed ${String(input['command'] ?? '')}`, isError: true }
      },
    })

    const responses = [
      toolUseResponse('bash', 'tool-1', { cwd: '/tmp/project', command: 'cd /tmp/project && python3 tests/smoke.py /tmp/run-1234.log' }),
      toolUseResponse('bash', 'tool-2', { cwd: '/tmp/project', command: 'cd /tmp/project && python3 tests/smoke.py /tmp/run-5678.log' }),
      toolUseResponse('bash', 'tool-3', { cwd: '/tmp/project', command: 'cd /tmp/project && python3 tests/smoke.py /tmp/run-9012.log' }),
      toolUseResponse('bash', 'tool-4', { cwd: '/tmp/project', command: 'cd /tmp/project && python3 tests/smoke.py /tmp/run-3456.log' }),
      textResponse('done diagnosing, here is the blocker'),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(error) {
          errors.push(error)
        },
      },
    })

    expect(errors).toHaveLength(0)
    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toContain('done diagnosing')
  })

  it('stops the third identical failing bash attempt by exact signature', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Keep rerunning the same generated script until it works')

    const dispatcher = new ToolDispatcher()
    let bashCalls = 0
    dispatcher.register({
      name: 'bash',
      description: 'test bash',
      async execute() {
        bashCalls += 1
        return { output: 'SyntaxError: invalid syntax', isError: true }
      },
    })

    const command = "python /tmp/gen_ppt.py"
    const responses = [
      toolUseResponse('bash', 'tool-1', { cwd: '/tmp/project', command }),
      toolUseResponse('bash', 'tool-2', { cwd: '/tmp/project', command }),
      toolUseResponse('bash', 'tool-3', { cwd: '/tmp/project', command }),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(error) {
          errors.push(error)
        },
      },
    })

    expect(bashCalls).toBe(2)
    expect(result.stopReason).toBe('tool_loop')
    expect(errors.at(-1)).toMatch(/repeated failing bash attempts/)
  })

  it('allows productive rereads of the same file when the read window changes', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Inspect different parts of the same file')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(input: any) {
        return {
          output: `read ${String(input['path'] ?? '')} ${String(input['startLine'] ?? '')}:${String(input['endLine'] ?? '')}`,
          isError: false,
        }
      },
    })

    const responses = [
      toolUseResponse('read', 'tool-1', { path: '/tmp/demo.ts', startLine: 1, endLine: 40 }),
      toolUseResponse('read', 'tool-2', { path: '/tmp/demo.ts', startLine: 41, endLine: 80 }),
      toolUseResponse('read', 'tool-3', { path: '/tmp/demo.ts:120' }),
      toolUseResponse('read', 'tool-4', { path: '/tmp/demo.ts', offset: 2048, limit: 512 }),
      textResponse('done'),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(error) {
          errors.push(error)
        },
      },
    })

    expect(errors).toHaveLength(0)
    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toBe('done')
  })

  it('keeps the runtime nudge attached to tool_result after 3 tool-only turns', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Inspect the file')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(input: any) {
        return { output: `read ${String(input['path'] ?? '')}`, isError: false }
      },
    })

    const requestBodies: Array<{ messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> }> = []
    const responses = [
      toolUseResponse('read', 'tool-1', { path: '/tmp/demo.ts' }),
      toolUseResponse('read', 'tool-2', { path: '/tmp/demo.ts' }),
      toolUseResponse('read', 'tool-3', { path: '/tmp/demo.ts' }),
      textResponse('summary'),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')))
      return responses.shift()!
    })

    const notices: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onNotice(message) {
          notices.push(message)
        },
      },
    })

    expect(result.stopReason).toBe('end_turn')
    expect(notices).toContain('Nudge: requesting text summary after 3 consecutive tool-only turns')

    const followupRequest = requestBodies[3]
    expect(followupRequest?.messages.at(-2)?.role).toBe('assistant')
    expect(followupRequest?.messages.at(-2)?.content.some(block => block.type === 'tool_use')).toBe(true)
    expect(followupRequest?.messages.at(-1)?.role).toBe('user')
    expect(followupRequest?.messages.at(-1)?.content.some(block => block.type === 'tool_result')).toBe(true)
    expect(
      followupRequest?.messages.at(-1)?.content.some(
        (block) => block.type === 'text' && block.text?.includes('3 consecutive tool calls'),
      ),
    ).toBe(true)
  })

  it('blocks 6 identical successful edits on the same file (true loop)', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Fix the file')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'edit',
      description: 'test edit',
      async execute(input: any) {
        return { output: `edited ${String(input['path'] ?? '')}`, isError: false }
      },
    })

    // With threshold of 5, 6 identical edits triggers the guard (5 in window + 1 next)
    const responses = [
      toolUseResponse('edit', 'tool-1', { path: '/tmp/demo.ts', oldStr: 'foo', newStr: 'bar' }),
      toolUseResponse('edit', 'tool-2', { path: '/tmp/demo.ts', oldStr: 'foo', newStr: 'bar' }),
      toolUseResponse('edit', 'tool-3', { path: '/tmp/demo.ts', oldStr: 'foo', newStr: 'bar' }),
      toolUseResponse('edit', 'tool-4', { path: '/tmp/demo.ts', oldStr: 'foo', newStr: 'bar' }),
      toolUseResponse('edit', 'tool-5', { path: '/tmp/demo.ts', oldStr: 'foo', newStr: 'bar' }),
      toolUseResponse('edit', 'tool-6', { path: '/tmp/demo.ts', oldStr: 'foo', newStr: 'bar' }), // 6th — blocked
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(errors.at(-1)).toContain('repeated update attempts')
    expect(result.stopReason).toBe('tool_loop')
  })

  it('keeps productive long exploration open past the old request threshold', async () => {
    const conv = createConversation({
      system: 'test',
      model: 'test-model',
      tools: [buildToolDef('read', 'test read', {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      })],
    })
    addUserMessage(conv, 'Keep exploring while new files still add evidence')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(input: any) {
        return { output: `function found in ${String(input['path'] ?? '')}`, isError: false }
      },
    })

    const requestBodies: any[] = []
    const responses = [
      toolUseResponse('read', 'tool-1', { path: '/tmp/a.ts' }),
      toolUseResponse('read', 'tool-2', { path: '/tmp/b.ts' }),
      toolUseResponse('read', 'tool-3', { path: '/tmp/c.ts' }),
      toolUseResponse('read', 'tool-4', { path: '/tmp/d.ts' }),
      textResponse('done'),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')))
      return responses.shift()!
    })

    const notices: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onNotice(message) {
          notices.push(message)
        },
      },
    })

    expect(result.stopReason).toBe('end_turn')
    expect(result.usage.requestCount).toBe(5)
    expect(requestBodies[3].tool_choice).toBeUndefined()
    expect(requestBodies[3].tools).toBeDefined()
    expect(notices.some((notice) => notice.startsWith('Synthesis phase:'))).toBe(false)
  })

  it('defer-executes large exploratory fan-out behind a summary gate', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Inspect a lot of files')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(input: any) {
        return { output: `function found in ${String(input['path'] ?? '')}`, isError: false }
      },
    })

    const requestBodies: any[] = []
    const responses = [
      contentResponse([
        { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: '/tmp/a.ts' } },
        { type: 'tool_use', id: 'tool-2', name: 'read', input: { path: '/tmp/b.ts' } },
        { type: 'tool_use', id: 'tool-3', name: 'read', input: { path: '/tmp/c.ts' } },
        { type: 'tool_use', id: 'tool-4', name: 'read', input: { path: '/tmp/d.ts' } },
        { type: 'tool_use', id: 'tool-5', name: 'read', input: { path: '/tmp/e.ts' } },
        { type: 'tool_use', id: 'tool-6', name: 'read', input: { path: '/tmp/f.ts' } },
      ], 'tool_use'),
      textResponse('Conclusion: Enough evidence.\n\nEvidence: Read the first batch.\n\nUncertainty: One deferred file may still hide an edge case.\n\nNext: Review the deferred path only if the first batch is insufficient.'),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')))
      return responses.shift()!
    })

    const notices: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onNotice(message) {
          notices.push(message)
        },
      },
    })

    expect(result.stopReason).toBe('end_turn')
    expect(notices).toContain('Summary gate: batched 4 exploratory tools and deferred 2 more until the assistant summarizes')
    expect(conv.turns[1]!.content.filter((block: any) => block.type === 'tool_use')).toHaveLength(4)
    expect(conv.turns[2]!.content.some((block: any) => block.type === 'text' && String(block.text).includes('Runtime summary gate'))).toBe(true)
    expect(requestBodies[1].messages.at(-2).content.filter((block: any) => block.type === 'tool_use')).toHaveLength(4)
  })

  it('treats repeatedly-ignored summary-gate exploration as a tool loop (counter-based)', async () => {
    // Before 0.12.5 a single summary-gate violation hard-stopped the
    // loop. That was too aggressive for real multi-file investigation
    // tasks — one extra read after the summary nudge was enough to
    // kill the whole turn. Now the loop nudges on each violation and
    // only hard-stops after the model has clearly refused to switch
    // modes (SUMMARY_GATE_VIOLATION_STOP_THRESHOLD) times in a row.
    // We feed enough violating responses to trip the threshold here.
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Keep exploring')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(input: any) {
        return { output: `function found in ${String(input['path'] ?? '')}`, isError: false }
      },
    })

    const responses = [
      // Iter 1 — triggers the summary gate (batched 5 tools).
      contentResponse([
        { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: '/tmp/a.ts' } },
        { type: 'tool_use', id: 'tool-2', name: 'read', input: { path: '/tmp/b.ts' } },
        { type: 'tool_use', id: 'tool-3', name: 'read', input: { path: '/tmp/c.ts' } },
        { type: 'tool_use', id: 'tool-4', name: 'read', input: { path: '/tmp/d.ts' } },
        { type: 'tool_use', id: 'tool-5', name: 'read', input: { path: '/tmp/e.ts' } },
      ], 'tool_use'),
      // Iters 2..6 — model keeps answering with an exploratory read
      // instead of summarizing. The threshold is 4 violations, so
      // iter 5 should emit the hard stop.
      toolUseResponse('read', 'tool-6', { path: '/tmp/f.ts' }),
      toolUseResponse('read', 'tool-7', { path: '/tmp/g.ts' }),
      toolUseResponse('read', 'tool-8', { path: '/tmp/h.ts' }),
      toolUseResponse('read', 'tool-9', { path: '/tmp/i.ts' }),
      toolUseResponse('read', 'tool-10', { path: '/tmp/j.ts' }),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const notices: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(error) { errors.push(error) },
        onNotice(notice) { notices.push(notice) },
      },
    })

    expect(result.stopReason).toBe('tool_loop')
    expect(errors.at(-1)).toMatch(/ignored the summary gate \d+ times in a row/)
    // Saw at least one "still pending" nudge before the final stop.
    expect(notices.some((n) => n.startsWith('Summary gate still pending'))).toBe(true)
  })

  it('switches into synthesis mode with a tool-free final-answer contract request', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Analyze the files and conclude')

    const dispatcher = new ToolDispatcher()
    const readCounts = new Map<string, number>()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(input: any) {
        const path = String(input['path'] ?? '')
        const count = (readCounts.get(path) ?? 0) + 1
        readCounts.set(path, count)
        if (path.endsWith('c.ts') && count > 1) {
          return { output: 'ok', isError: false }
        }
        return { output: `function found in ${path}`, isError: false }
      },
    })

    const requestBodies: any[] = []
    const responses = [
      contentResponse([
        { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: '/tmp/a.ts' } },
        { type: 'tool_use', id: 'tool-2', name: 'read', input: { path: '/tmp/b.ts' } },
      ], 'tool_use'),
      toolUseResponse('read', 'tool-3', { path: '/tmp/c.ts' }),
      toolUseResponse('read', 'tool-4', { path: '/tmp/c.ts' }),
      toolUseResponse('read', 'tool-5', { path: '/tmp/c.ts' }),
      textResponse('Conclusion: The runtime now converges after progress plateaus.\n\nEvidence: The last two reads repeated the same target without yielding fresh evidence.\n\nUncertainty: There may still be edge-case drift outside the sampled files.\n\nNext: Tighten the synthesis wording and retest.'),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')))
      return responses.shift()!
    })

    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
    })

    expect(result.stopReason).toBe('end_turn')
    expect(result.usage.requestCount).toBe(5)
    expect(requestBodies[4].tool_choice).toEqual({ type: 'none' })
    expect(requestBodies[4].tools).toBeUndefined()
    expect(requestBodies[4].stream).toBe(false)
    expect(requestBodies[4].max_tokens).toBe(900)
    expect(requestBodies[4].stop_sequences).toContain('\n[TOOL_CALL]')
    expect(String(requestBodies[4].messages[0].content[0].text)).toContain('Evidence:')
  })

  it('treats pseudo tool-call text as unusable synthesis and recovers via fallback synthesis', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Analyze and conclude')

    const dispatcher = new ToolDispatcher()
    const readCounts = new Map<string, number>()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(input: any) {
        const path = String(input['path'] ?? '')
        const count = (readCounts.get(path) ?? 0) + 1
        readCounts.set(path, count)
        if (path.endsWith('c.ts') && count > 1) {
          return { output: 'ok', isError: false }
        }
        return { output: `function found in ${path}`, isError: false }
      },
    })

    const requestBodies: any[] = []
    const responses = [
      contentResponse([
        { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: '/tmp/a.ts' } },
        { type: 'tool_use', id: 'tool-2', name: 'read', input: { path: '/tmp/b.ts' } },
      ], 'tool_use'),
      toolUseResponse('read', 'tool-3', { path: '/tmp/c.ts' }),
      toolUseResponse('read', 'tool-4', { path: '/tmp/c.ts' }),
      toolUseResponse('read', 'tool-5', { path: '/tmp/c.ts' }),
      textResponse('[TOOL_CALL]\nread /tmp/d.ts\n[/TOOL_CALL]'),
      textResponse('Conclusion: The synthesis validator rejected pseudo tool output and forced a fallback close.\n\nEvidence: The first synthesis reply emitted TOOL_CALL markup instead of a contract answer.\n\nUncertainty: Quality can still drift even when shape is enforced.\n\nNext: Keep the fallback path, then tighten wording and rerun live minimax.'),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')))
      return responses.shift()!
    })

    const notices: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onNotice(message) {
          notices.push(message)
        },
      },
    })

    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toContain('Conclusion:')
    expect(result.usage.requestCount).toBe(6)
    expect(notices.some((notice) => notice.startsWith('Fallback synthesis:'))).toBe(true)
    expect(requestBodies[5].max_tokens).toBe(650)
    expect(requestBodies[5].tool_choice).toEqual({ type: 'none' })
  })

  it('accepts free-form final-answer prose without the 4-section contract', async () => {
    // After 0.12.4 the validator is soft on shape — a free-form prose answer
    // that is non-empty, doesn't beg for tools, and doesn't emit pseudo
    // tool-call text is accepted as-is. The old rigid contract
    // (Conclusion/Evidence/Uncertainty/Next required) trapped real long
    // sessions at hard_stop even after the model had done useful work
    // (wrote files, ran commands) — kimi-for-coding and other thinking
    // models don't naturally emit the exact section labels at the end of
    // a complex multi-iteration turn. The hard-reject cases (empty,
    // tool-begging, pseudo tool-call, escape-to-more-exploration) still
    // trigger fallback / hard_stop — see the two preceding tests.
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Analyze and conclude')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(input: any) {
        return { output: `function found in ${String(input['path'] ?? '')}`, isError: false }
      },
    })

    const responses = [
      contentResponse([
        { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: '/tmp/a.ts' } },
        { type: 'tool_use', id: 'tool-2', name: 'read', input: { path: '/tmp/b.ts' } },
      ], 'tool_use'),
      toolUseResponse('read', 'tool-3', { path: '/tmp/c.ts' }),
      toolUseResponse('read', 'tool-4', { path: '/tmp/c.ts' }),
      toolUseResponse('read', 'tool-5', { path: '/tmp/c.ts' }),
      textResponse('I finished the investigation. The three files define the feature pipeline and look consistent.'),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const notices: string[] = []
    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onNotice(message) { notices.push(message) },
        onError(error) { errors.push(error) },
      },
    })

    expect(result.stopReason).not.toBe('hard_stop')
    expect(result.finalText).toContain('I finished the investigation')
    // Fallback should NOT have fired — free-form prose is accepted directly.
    expect(notices.some((n) => n.startsWith('Fallback synthesis:'))).toBe(false)
    expect(notices.some((n) => n.startsWith('Hard stop:'))).toBe(false)
    expect(errors.length).toBe(0)
  })

  it('does not escalate task-contract blocks into tool_loop while the model realigns', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Only touch `src/native/allowed.ts` while following the packet.')

    const responses = [
      toolUseResponse('edit', 'tool-1', { path: '/tmp/blocked.ts', oldStr: 'a', newStr: 'b' }),
      toolUseResponse('edit', 'tool-2', { path: '/tmp/blocked.ts', oldStr: 'b', newStr: 'c' }),
      textResponse('I need the user to expand the task contract before editing outside the allowed scope.'),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      maxIterations: 4,
      callbacks: {
        onError(error) {
          errors.push(error)
        },
      },
    })

    expect(errors).toHaveLength(0)
    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toContain('expand the task contract')
    expect(result.conversation.options?.taskState?.run.status).toBe('waiting_user')
  })

  it('stops parent continuation after a terminal Agent failure', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Delegate the long audit and do not improvise if the agent fails.')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'Agent',
      description: 'test agent',
      async execute() {
        return {
          output: 'Agent incomplete: stop_reason=max_iterations',
          isError: true,
          metadata: {
            terminalToolFailure: true,
            terminalFailureReason: 'Sub-agent hit max_iterations before producing a final message.',
          },
        }
      },
    })

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(toolUseResponse('Agent', 'tool-agent-1', {
      description: 'Long audit',
      prompt: 'Audit deeply',
    }))

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      maxIterations: 4,
      callbacks: {
        onError(error) {
          errors.push(error)
        },
      },
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.stopReason).toBe('terminal_tool_failure')
    expect(result.finalText).toBe('')
    expect(errors).toContain('Sub-agent hit max_iterations before producing a final message.')
    expect(result.conversation.options?.taskState?.run.status).toBe('drifted')
    expect(result.conversation.options?.taskState?.run.lastGuardReason).toContain('max_iterations')
  })

  it('keeps runtimeFailure null on terminal tool failure so the REPL does not auto-continue', async () => {
    // The cmux 0.13.20 evidence showed the parent loop continuing past a
    // sub-agent max_iterations failure and letting the model produce
    // false claims ("`owlcoda` code has no iteration limit"). The
    // terminal-tool-failure contract is: the parent stops cleanly, no
    // runtimeFailure is synthesised, and the REPL's auto-retry gate
    // refuses to fire because runtimeFailure is null. Together those
    // guarantees keep the model from improvising over a known incomplete
    // sub-agent run.
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Delegate the long audit; do not improvise on terminal failure.')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'Agent',
      description: 'test agent',
      async execute() {
        return {
          output: 'Agent incomplete: stop_reason=max_iterations',
          isError: true,
          metadata: {
            terminalToolFailure: true,
            terminalFailureReason: 'Sub-agent hit max_iterations before producing a final message.',
          },
        }
      },
    })

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(toolUseResponse('Agent', 'tool-agent-2', {
      description: 'Long audit',
      prompt: 'Audit deeply',
    }))

    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      maxIterations: 4,
    })

    expect(result.stopReason).toBe('terminal_tool_failure')
    expect(result.runtimeFailure).toBeNull()
    expect(shouldScheduleRuntimeAutoRetry({
      runtimeFailure: result.runtimeFailure,
      taskAborted: false,
      clearEpochUnchanged: true,
      currentRetryCount: 0,
      retryLimit: 8,
      hasQueuedInput: false,
    })).toBe(false)
  })
})

// Default-ON cost-burn protection. detectToolLoop must fire WITHOUT the
// user opting into strict agentic mode — the production bug was that the
// model could call the same failing tool 100+ times because the guard
// only ran when OWLCODA_AGENTIC_MODE=strict was explicitly set.
describe('native conversation tool loop guard default (cost-burn protection)', () => {
  beforeEach(() => {
    delete process.env['OWLCODA_AGENTIC_MODE']
    delete process.env['OWLCODA_LOOP_GUARD']
    process.env['OWLCODA_LOOP_INTERCEPT'] = 'hard'
  })
  afterEach(() => {
    delete process.env['OWLCODA_AGENTIC_MODE']
    delete process.env['OWLCODA_LOOP_GUARD']
    delete process.env['OWLCODA_LOOP_INTERCEPT']
  })

  it('hard-stops infinitely repeated identical failing tool_use even in free mode', async () => {
    // Reproduces the prod cost-burn: model keeps calling Skill with the
    // same missing-param payload and the same error comes back. We feed
    // the same tool_use 5 times — the guard must trip well before that
    // and never let the loop balloon.
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Stress the loop with the same failing call')

    const dispatcher = new ToolDispatcher()
    let executions = 0
    dispatcher.register({
      name: 'Skill',
      description: 'test skill',
      async execute() {
        executions += 1
        return { output: 'Error: skill name is required for action "run"', isError: true }
      },
    })

    const responses = Array.from({ length: 8 }, (_, i) =>
      toolUseResponse('Skill', `tool-${i + 1}`, { action: 'run' }),
    )
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(result.stopReason).toBe('tool_loop')
    expect(errors.at(-1)).toMatch(/repeated failing .* attempts/)
    // Threshold is ≥2 same failures in window. Attempts 1 and 2 execute
    // (recording two error attempts); the loop trips on attempt 3 BEFORE
    // it executes — so the dispatcher runs at most 2 times.
    expect(executions).toBeLessThanOrEqual(2)
  })

  it('2026-05-28: 3 distinct sub-agent isolated failures do NOT trip same-class loop guard', async () => {
    // Hierarchical orchestrator-subagent invariant: a parent fan-outing N
    // sub-agents with different prompts and seeing M of them report
    // subAgentIsolatedFailure is NORMAL behaviour, not a stuck loop. The
    // parent LLM should still receive each failure as a tool_result and
    // decide what to do next (retry / skip / abort).
    //
    // Pre-fix (2026-05-28 second-order incident): detectToolLoop's
    // failureClassCounts counter aggregated all (Agent, agent:no_deliverable)
    // events regardless of which sub-agent failed, so 3 distinct
    // research deliverables each failing with no_deliverable hard-killed
    // the parent task as "tool_loop". Post-fix:
    // recordToolAttempt skips failureCategory when metadata has
    // subAgentIsolatedFailure=true, so isolated sub-agent failures do not
    // accumulate in the same-class counter. The signature- and intentKey-
    // based guards still fire if the parent actually re-runs the SAME
    // Agent call repeatedly.
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Run 4 independent research sub-agents; some may fail in isolation.')

    const dispatcher = new ToolDispatcher()
    let executions = 0
    dispatcher.register({
      name: 'Agent',
      description: 'fake sub-agent',
      async execute(input: Record<string, unknown>) {
        executions += 1
        // First 3 fan-out targets fail in isolation. The 4th succeeds —
        // proving the parent loop kept dispatching past the (would-be)
        // 3-same-class threshold.
        const desc = String(input['description'] ?? '')
        if (desc === 'D4') {
          return {
            output: 'OK done.',
            isError: false,
            metadata: { agentId: 'agent-ok', agentType: 'general-purpose' },
          }
        }
        return {
          output: 'Agent incomplete: sub-agent required file output but produced none.',
          isError: true,
          metadata: {
            agentId: `agent-${desc}`,
            agentType: 'general-purpose',
            agentIncomplete: true,
            agentNoDeliverable: true,
            subAgentIsolatedFailure: true,
            completion_status: 'failed',
            failureCategory: 'agent:no_deliverable',
            failureMessage: 'Sub-agent required file output but produced none.',
          },
        }
      },
    })

    const responses = [
      toolUseResponse('Agent', 'tool-d1', { description: 'D1', prompt: 'do d1' }),
      toolUseResponse('Agent', 'tool-d2', { description: 'D2', prompt: 'do d2' }),
      toolUseResponse('Agent', 'tool-d3', { description: 'D3', prompt: 'do d3' }),
      toolUseResponse('Agent', 'tool-d4', { description: 'D4', prompt: 'do d4' }),
      textResponse('3 of 4 sub-agents failed in isolation; D4 produced a deliverable. Done.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    // Invariants:
    //   - All 4 sub-agent calls dispatched (3 failed, 1 succeeded).
    //   - No tool_loop hard-stop (this is the hotfix surface).
    //   - Loop reached natural end_turn after the parent's summary turn.
    expect(executions).toBe(4)
    expect(result.stopReason).toBe('end_turn')
    expect(errors).toEqual([])
    expect(result.finalText).toContain('3 of 4')
  })

  it('2026-05-28: parent re-issuing the SAME Agent prompt 3x still trips loop guard (intentKey-based)', async () => {
    // Companion to the isolated-failures test above: the isolation contract
    // should not become a "loop guard escape hatch". If the parent really is
    // stuck calling Agent({prompt:'X'}) three times in a row, the signature/
    // intentKey-based guards must still fire — those don't depend on
    // failureCategory.
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Stuck-parent reproduction.')

    const dispatcher = new ToolDispatcher()
    let executions = 0
    dispatcher.register({
      name: 'Agent',
      description: 'fake sub-agent',
      async execute() {
        executions += 1
        return {
          output: 'Agent incomplete: sub-agent required file output but produced none.',
          isError: true,
          metadata: {
            agentId: 'agent-stuck',
            agentType: 'general-purpose',
            subAgentIsolatedFailure: true,
            completion_status: 'failed',
            failureCategory: 'agent:no_deliverable',
          },
        }
      },
    })

    const responses = [
      toolUseResponse('Agent', 'tool-a', { description: 'X', prompt: 'identical prompt X' }),
      toolUseResponse('Agent', 'tool-b', { description: 'X', prompt: 'identical prompt X' }),
      toolUseResponse('Agent', 'tool-c', { description: 'X', prompt: 'identical prompt X' }),
      toolUseResponse('Agent', 'tool-d', { description: 'X', prompt: 'identical prompt X' }),
      textResponse('giving up'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    // Should hard-stop (signature-based same-failure guard at ≥2 same
    // failing signatures, OR intentKey-based at ≥3, whichever fires first).
    // Either tool_loop or terminal stop is acceptable — what matters is the
    // parent does NOT reach end_turn after silently looping on the same
    // prompt forever.
    expect(result.stopReason === 'tool_loop' || result.stopReason === 'terminal_tool_failure').toBe(true)
    expect(executions).toBeLessThanOrEqual(3)
    expect(errors.length).toBeGreaterThanOrEqual(1)
  })

  it('disables loop guard when OWLCODA_LOOP_GUARD=off so users have an escape hatch', async () => {
    process.env['OWLCODA_LOOP_GUARD'] = 'off'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Run with loop guard explicitly off')

    const dispatcher = new ToolDispatcher()
    let executions = 0
    dispatcher.register({
      name: 'Skill',
      description: 'test skill',
      async execute() {
        executions += 1
        return { output: 'Error: skill name is required for action "run"', isError: true }
      },
    })

    const responses = [
      toolUseResponse('Skill', 'tool-1', { action: 'run' }),
      toolUseResponse('Skill', 'tool-2', { action: 'run' }),
      toolUseResponse('Skill', 'tool-3', { action: 'run' }),
      toolUseResponse('Skill', 'tool-4', { action: 'run' }),
      textResponse('giving up'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    // With the guard off the loop runs to completion — all 4 failing
    // tool_use blocks dispatch and the model's final text-turn ends it.
    expect(result.stopReason).toBe('end_turn')
    expect(errors).toHaveLength(0)
    expect(executions).toBe(4)
  })

  it('still fires the guard when OWLCODA_LOOP_GUARD is set to a non-off value', async () => {
    process.env['OWLCODA_LOOP_GUARD'] = 'on'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Run with loop guard explicitly on')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'Skill',
      description: 'test skill',
      async execute() {
        return { output: 'Error: skill name is required for action "run"', isError: true }
      },
    })

    const responses = Array.from({ length: 6 }, (_, i) =>
      toolUseResponse('Skill', `tool-${i + 1}`, { action: 'run' }),
    )
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(result.stopReason).toBe('tool_loop')
    expect(errors.at(-1)).toMatch(/repeated failing .* attempts/)
  })

  it('does not cut bash loop error targets in the middle of prod-eval', async () => {
    process.env['OWLCODA_LOOP_GUARD'] = 'on'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Run production eval until the blocker is clear')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'bash',
      description: 'test bash',
      async execute() {
        return { output: 'prod eval failed', isError: true }
      },
    })

    const command = `${'x'.repeat(73)}prod-eval --suite long-headless`
    const responses = Array.from({ length: 4 }, (_, i) =>
      toolUseResponse('bash', `tool-${i + 1}`, {
        cwd: '/tmp/owlcoda',
        command,
      }),
    )
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(result.stopReason).toBe('tool_loop')
    expect(errors.at(-1)).toContain('prod-eval')
  })

  it('semantic-failure guard: same failureCategory across different signatures trips quickly', async () => {
    // The detector should treat metadata.failureCategory as the no-progress
    // axis. A model rotating through signatures that all classify as the
    // same failure class should be stopped within ~3 same-class events.
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Same-class test')

    const dispatcher = new ToolDispatcher()
    let executions = 0
    dispatcher.register({
      name: 'Skill',
      description: 'test skill',
      async execute(input: any) {
        executions += 1
        const action = input?.action
        const name = input?.name
        if (action === 'list') {
          return {
            output: '(no skills available)',
            isError: false,
            metadata: { failureCategory: 'skill:no_available_skill_or_invalid_call' },
          }
        }
        if (!name) {
          return {
            output: `skill name required for ${action}`,
            isError: true,
            metadata: { failureCategory: 'skill:no_available_skill_or_invalid_call' },
          }
        }
        return {
          output: `Skill "${name}" not found`,
          isError: true,
          metadata: { failureCategory: 'skill:no_available_skill_or_invalid_call' },
        }
      },
    })

    const cycle = [
      { action: 'list' },
      { action: 'run' },
      { action: 'info' },
      { action: 'run', name: 'x' },
      { action: 'info', name: 'x' },
    ]
    const responses = Array.from({ length: 12 }, (_, i) =>
      toolUseResponse('Skill', `tool-${i + 1}`, cycle[i % cycle.length]),
    )
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(result.stopReason).toBe('tool_loop')
    expect(errors.at(-1)).toMatch(/skill:no_available_skill_or_invalid_call|cycling through|recent attempts failed|same-class/)
    // Detector fires when prior 3 same-class events accumulate, so attempt 4
    // is the one that gets refused. 3 executions max.
    expect(executions).toBeLessThanOrEqual(4)
  })

  it('distinct Skill error subcategories do NOT trip the same-class guard (regression for hostile-QA against 0.13.38)', async () => {
    // 0.13.38 hostile-QA hit a false positive: legitimate negative testing
    // across distinct Skill error paths (no-name, unknown-action, not-found)
    // all fed the same `skill:no_available_skill_or_invalid_call` umbrella
    // category, so 3 different one-shot probes tripped the guard. 0.13.40
    // splits the umbrella into invalid-action / missing-name / not-found /
    // registry-empty, so a sequence of distinct probes is exploration,
    // not a cycle.
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'distinct subcategory probe test')

    const dispatcher = new ToolDispatcher()
    let executions = 0
    dispatcher.register({
      name: 'Skill',
      description: 'test skill (split categories)',
      async execute(input: any) {
        executions += 1
        const action = input?.action
        const name = input?.name
        if (action === 'list') {
          return {
            output: '64 skill(s) available',
            isError: false,
            metadata: { count: 64 },
          }
        }
        if (action === 'unknown_xyz') {
          return {
            output: 'unknown action',
            isError: true,
            metadata: { failureCategory: 'skill:invalid-action' },
          }
        }
        if (!name) {
          return {
            output: 'name required',
            isError: true,
            metadata: { failureCategory: 'skill:missing-name' },
          }
        }
        if (name === 'definitely-not-a-skill') {
          return {
            output: 'not found',
            isError: true,
            metadata: { failureCategory: 'skill:not-found' },
          }
        }
        return { output: '# real skill body', isError: false }
      },
    })

    // Six distinct probes, four distinct error subcategories,
    // followed by a real exit so the guard has a chance to trip.
    const probeSequence = [
      { action: 'list' },                                                  // success
      { action: 'run' },                                                   // missing-name
      { action: 'unknown_xyz' },                                           // invalid-action
      { action: 'info', name: 'definitely-not-a-skill' },                  // not-found
      { action: 'run', name: 'definitely-not-a-skill' },                   // not-found (#2)
      { action: 'run', name: 'real-skill' },                               // success
    ]
    const responses = probeSequence.map((input, i) =>
      toolUseResponse('Skill', `tool-${i + 1}`, input),
    )
    responses.push(textResponse('done'))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(result.stopReason).not.toBe('tool_loop')
    expect(executions).toBe(probeSequence.length)
    expect(errors.filter((e) => /tool loop/.test(e))).toEqual([])
  })

  it('detects multi-signature rotation (model dodging same-signature check)', async () => {
    // Real reproduction from 0.13.33 hostile-mode test: model cycles
    // through 6 distinct Skill signatures (action: list / run / info, with
    // and without name) so each individual signature only appears 1–2
    // times within the window — sameFailures(>=2) never trips. The
    // multi-signature rotation guard catches it instead.
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Test rotation')

    const dispatcher = new ToolDispatcher()
    let executions = 0
    dispatcher.register({
      name: 'Skill',
      description: 'test skill',
      async execute(input: any) {
        executions += 1
        const action = input?.action
        const name = input?.name
        if (action === 'list') {
          return { output: '(no skills available)', isError: false }
        }
        if (!name) return { output: `skill name required for ${action}`, isError: true }
        return { output: `Skill "${name}" not found`, isError: true }
      },
    })

    // 6-signature cycle. Repeat enough times to fill the window.
    const cycle = [
      { action: 'list' },
      { action: 'run' },
      { action: 'info' },
      { action: 'run', name: 'nonexistent' },
      { action: 'info', name: 'nonexistent' },
      { action: 'list', name: 'should-be-ignored' },
    ]
    const responses = Array.from({ length: 30 }, (_, i) =>
      toolUseResponse('Skill', `tool-${i + 1}`, cycle[i % cycle.length]),
    )
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(result.stopReason).toBe('tool_loop')
    // Either the rotation guard or the failure-rate guard should fire.
    expect(errors.at(-1)).toMatch(/cycling through|recent (?:\w+ )?attempts failed|repeated failing/)
    // Should stop well before all 30 attempts are dispatched.
    expect(executions).toBeLessThan(20)
  })

  it('detects high failure rate even when signatures vary', async () => {
    // If a model keeps generating slightly different failing calls the
    // cycle detector may miss them, but the failure-rate fallback should
    // still trip when 2/3+ of recent attempts are errors.
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Test failure rate')

    const dispatcher = new ToolDispatcher()
    let executions = 0
    dispatcher.register({
      name: 'Skill',
      description: 'test skill',
      async execute() {
        executions += 1
        return { output: 'failure', isError: true }
      },
    })

    // Each call has a unique payload — no signature ever repeats.
    const responses = Array.from({ length: 15 }, (_, i) =>
      toolUseResponse('Skill', `tool-${i + 1}`, { action: 'run', name: `unique-${i}` }),
    )
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(result.stopReason).toBe('tool_loop')
    expect(errors.at(-1)).toMatch(/recent (?:\w+ )?attempts failed|cycling through/)
    expect(executions).toBeLessThan(15)
  })
})

// 0.13.55 soft intercept. Default behavior (no env var set): when the
// loop guard fires, instead of immediately terminating with stopReason
// 'tool_loop', synthesize a tool_result for the offending tool_use
// asking the model to summarize root cause + propose patches + ask the
// user. Conversation continues. Only on the SECOND hit on the same
// intentKey do we hard-terminate.
describe('native conversation tool loop guard SOFT intercept (0.13.55 default)', () => {
  beforeEach(() => {
    process.env['OWLCODA_AGENTIC_MODE'] = 'strict'
    delete process.env['OWLCODA_LOOP_INTERCEPT']  // default = soft
  })
  afterEach(() => {
    delete process.env['OWLCODA_AGENTIC_MODE']
    delete process.env['OWLCODA_LOOP_INTERCEPT']
  })

  it('soft-intercepts the first loop trigger and lets the conversation continue', async () => {
    // 0.14.10: switched the offending tool from bash → Skill. bash is
    // now exempt from signature-based detection (see detectToolLoop),
    // so the soft-intercept mechanism is exercised through a tool that
    // still participates in the detector.
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Keep retrying a missing skill until you can report')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'Skill',
      description: 'test skill',
      async execute(input: any) {
        return { output: `Skill "${String(input?.name ?? '')}" not found`, isError: true }
      },
    })

    // 3 same-signature failing Skill calls + 1 text response (model breaks
    // out after intercept). Loop guard's same-signature failure
    // threshold is >= 2 (at the 3rd identical signature failure), so
    // the 3rd attempt should soft-intercept.
    const responses = [
      toolUseResponse('Skill', 'tool-1', { action: 'run', name: 'nonexistent' }),
      toolUseResponse('Skill', 'tool-2', { action: 'run', name: 'nonexistent' }),
      toolUseResponse('Skill', 'tool-3', { action: 'run', name: 'nonexistent' }),
      textResponse('Root cause: X. Two patch options: A or B. Which do you want?'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const notices: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(e) { errors.push(e) },
        onNotice(n) { notices.push(n) },
      },
    })

    // Soft intercept fired (notice surfaced) but conversation continued
    // and ended on the model's text response, not stopReason='tool_loop'.
    expect(notices.some((n) => /Loop intercept \(soft\)/.test(n))).toBe(true)
    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toContain('Which do you want?')
    // No hard terminal error fired in soft mode.
    expect(errors.filter((e) => /tool loop/.test(e))).toEqual([])

    // The intercept was delivered as a synthesized tool_result block
    // visible in the conversation. Walk the user-role turns and find
    // a tool_result with metadata.loopIntercept.
    const sawIntercept = conv.turns.some((turn) =>
      turn.role === 'user' && turn.content.some((b: any) =>
        b?.type === 'tool_result' && /Runtime loop intercept/.test(String(b?.content ?? ''))
      )
    )
    expect(sawIntercept).toBe(true)
  })

  it('escalates to hard terminate on the SECOND loop trigger for the same intentKey', async () => {
    // 0.14.10: switched offending tool from bash → Skill (bash is now
    // exempt from signature-based detection).
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Keep retrying despite the intercept')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'Skill',
      description: 'test skill',
      async execute(input: any) {
        return { output: `Skill "${String(input?.name ?? '')}" not found`, isError: true }
      },
    })

    // 3 failing Skill → soft intercept on the 3rd. Then the model
    // ignores the intercept and emits the same Skill again. The 4th
    // hit on the same intentKey escalates from soft to hard terminate.
    const responses = [
      toolUseResponse('Skill', 'tool-1', { action: 'run', name: 'nonexistent' }),
      toolUseResponse('Skill', 'tool-2', { action: 'run', name: 'nonexistent' }),
      toolUseResponse('Skill', 'tool-3', { action: 'run', name: 'nonexistent' }),
      toolUseResponse('Skill', 'tool-4', { action: 'run', name: 'nonexistent' }),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const notices: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(e) { errors.push(e) },
        onNotice(n) { notices.push(n) },
      },
    })

    expect(notices.some((n) => /Loop intercept \(soft\)/.test(n))).toBe(true)
    expect(result.stopReason).toBe('tool_loop')
    expect(errors.some((e) => /tool loop/.test(e))).toBe(true)
  })

  it('OWLCODA_LOOP_INTERCEPT=hard preserves the legacy immediate-terminate behavior', async () => {
    // 0.14.10: switched offending tool from bash → Skill (bash is now
    // exempt from signature-based detection).
    process.env['OWLCODA_LOOP_INTERCEPT'] = 'hard'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Legacy hard mode test')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'Skill',
      description: 'test skill',
      async execute(_input: any) {
        return { output: 'Skill not found', isError: true }
      },
    })

    const responses = [
      toolUseResponse('Skill', 'tool-1', { action: 'run', name: 'nonexistent' }),
      toolUseResponse('Skill', 'tool-2', { action: 'run', name: 'nonexistent' }),
      toolUseResponse('Skill', 'tool-3', { action: 'run', name: 'nonexistent' }),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(result.stopReason).toBe('tool_loop')
    expect(errors.some((e) => /tool loop/.test(e))).toBe(true)
  })
})

// 0.13.70 execution_economics_v1 — production_gate_v1 inject. Fires
// once per task when the model has read >=3 distinct files across
// >=5 lifetime iterations under a write-required task contract with
// 0 touched paths. Earlier and softer than 0.13.68's hard-stop:
// pushes the model to switch to producing without breaking the
// loop. Distinct from the narration-loop and no-progress detectors
// in that it's advisory, not terminal.
describe('production gate v1 (0.13.70)', () => {
  beforeEach(() => {
    process.env['OWLCODA_AGENTIC_MODE'] = 'strict'
  })
  afterEach(() => {
    delete process.env['OWLCODA_AGENTIC_MODE']
  })

  it('injects [Runtime production gate] once when 3+ files read across 5+ iter under write-required task with 0 touches', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Write the contract intake document to docs/intake.md')
    if (!conv.options) conv.options = {}
    const taskState = ensureTaskExecutionState(conv)
    conv.options.taskState = taskState

    // Pre-seed the read ledger with 3 distinct files. The
    // production-gate check reads from the same WeakMap the read
    // tool would have populated; bypassing the actual read tool
    // here keeps the test focused on the gate's own logic.
    recordReadAndBuildNudge(taskState, '/abs/file-1.ts', 'full', 1000, 100)
    recordReadAndBuildNudge(taskState, '/abs/file-2.ts', 'full', 1000, 100)
    recordReadAndBuildNudge(taskState, '/abs/file-3.ts', 'full', 1000, 100)

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'file contents', isError: false }
      },
    })

    // 5 read iterations + 1 final text — gate should fire on iter 6
    // (which is when lifetimeIterations crosses 5 at the top of the
    // iteration), then the loop continues so the final text-only
    // response can land cleanly.
    const responses = [
      ...Array.from({ length: 5 }, (_, i) =>
        toolUseResponse('read', `tool-${i + 1}`, { path: `/abs/file-${(i % 3) + 1}.ts` })
      ),
      textResponse('Drafted with unknowns flagged.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const notices: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onNotice(n) { notices.push(n) } },
    })

    // Notice was emitted to the operator.
    expect(notices.some((n) => /^Production gate:/.test(n))).toBe(true)
    expect(notices.some((n) => /3 distinct files read/.test(n))).toBe(true)
    // Inject was pushed into the conversation as a synthetic user turn.
    const injectedUserTurns = conv.turns.filter(
      (t) =>
        t.role === 'user'
        && Array.isArray(t.content)
        && t.content.some((c: any) => c.type === 'text' && /\[Runtime production gate\]/.test(c.text)),
    )
    expect(injectedUserTurns).toHaveLength(1)
    // One-shot flag is set.
    expect(taskState.run.productionGateFired).toBe(true)
    // Did NOT break the loop — final text response was processed.
    expect(result.stopReason).not.toBe('task_no_progress')
  })

  it('does not name external reference paths as task-scoped write targets', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(
      conv,
      [
        '先读 /Users/publicuser/AI/OwlManage/docs/prompts/industrial-ai-agent-ppt-v1.4-new-executor-full-rebuild-prompt-20260514.md',
        '再读 /Users/publicuser/work/ppt/claude-design-input-v1.3.1/06-new-executor-v1.4-full-rebuild.md',
        '目标产物：46 页 HTML PPT + build notes',
        '只交付：',
        '1. HTML',
        '   建议文件名：`工业AI-Agent-v1.4-content-rebuild-46p.html`',
        '2. build notes',
        '   建议文件名：`build-notes-v1.4-content-rebuild-46p.md`',
      ].join('\n'),
    )
    if (!conv.options) conv.options = {}
    const taskState = ensureTaskExecutionState(conv)
    conv.options.taskState = taskState

    recordReadAndBuildNudge(taskState, '/abs/file-1.md', 'full', 1000, 100)
    recordReadAndBuildNudge(taskState, '/abs/file-2.md', 'full', 1000, 100)
    recordReadAndBuildNudge(taskState, '/abs/file-3.md', 'full', 1000, 100)

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'source material', isError: false }
      },
    })

    const responses = [
      ...Array.from({ length: 5 }, (_, i) =>
        toolUseResponse('read', `tool-${i + 1}`, { path: `/abs/file-${(i % 3) + 1}.md` })
      ),
      textResponse('I will now produce the artifacts.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
    })

    const injectedUserTurns = conv.turns.filter(
      (t) =>
        t.role === 'user'
        && Array.isArray(t.content)
        && t.content.some((c: any) => c.type === 'text' && /\[Runtime production gate\]/.test(c.text)),
    )
    expect(injectedUserTurns).toHaveLength(1)
    const injectedText = JSON.stringify(injectedUserTurns[0].content)
    expect(injectedText).not.toContain('/Users/publicuser/AI/OwlManage/docs/prompts/')
    expect(injectedText).not.toContain('/Users/publicuser/work/ppt/claude-design-input-v1.3.1/')
    expect(injectedText).not.toContain('build-notes-v1.4-content-rebuild-46p.md')
    expect(injectedText).toContain('path scoped by the task contract')
  })

  it('does NOT fire when fewer than 3 distinct files have been read (investigation not yet meaningful)', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Write the design notes to docs/design.md')
    if (!conv.options) conv.options = {}
    const taskState = ensureTaskExecutionState(conv)
    conv.options.taskState = taskState

    // Only 2 distinct files seeded — below threshold.
    recordReadAndBuildNudge(taskState, '/abs/only-1.ts', 'full', 1000, 100)
    recordReadAndBuildNudge(taskState, '/abs/only-2.ts', 'full', 1000, 100)

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'x', isError: false }
      },
    })

    const responses = [
      ...Array.from({ length: 6 }, (_, i) => toolUseResponse('read', `tool-${i + 1}`, { path: `/abs/only-${(i % 2) + 1}.ts` })),
      textResponse('done'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const notices: string[] = []
    await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onNotice(n) { notices.push(n) } },
    })

    expect(notices.some((n) => /^Production gate:/.test(n))).toBe(false)
    expect(taskState.run.productionGateFired).toBeFalsy()
  })

  it('does NOT fire when task does not require writes (analysis-only task)', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, '解释一下这段代码做什么')
    if (!conv.options) conv.options = {}
    const taskState = ensureTaskExecutionState(conv)
    conv.options.taskState = taskState

    // Plenty of files seeded — but task is analysis, gate shouldn't fire.
    recordReadAndBuildNudge(taskState, '/abs/code-1.ts', 'full', 1000, 100)
    recordReadAndBuildNudge(taskState, '/abs/code-2.ts', 'full', 1000, 100)
    recordReadAndBuildNudge(taskState, '/abs/code-3.ts', 'full', 1000, 100)
    recordReadAndBuildNudge(taskState, '/abs/code-4.ts', 'full', 1000, 100)

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'x', isError: false }
      },
    })

    const responses = [
      ...Array.from({ length: 6 }, (_, i) => toolUseResponse('read', `tool-${i + 1}`, { path: `/abs/code-${(i % 4) + 1}.ts` })),
      textResponse('Here is the analysis: ...'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const notices: string[] = []
    await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onNotice(n) { notices.push(n) } },
    })

    expect(notices.some((n) => /^Production gate:/.test(n))).toBe(false)
    expect(taskState.run.productionGateFired).toBeFalsy()
  })

  it('is one-shot per task: subsequent iterations do not re-inject', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Write the spec to docs/spec.md')
    if (!conv.options) conv.options = {}
    const taskState = ensureTaskExecutionState(conv)
    conv.options.taskState = taskState

    recordReadAndBuildNudge(taskState, '/abs/a.ts', 'full', 1000, 100)
    recordReadAndBuildNudge(taskState, '/abs/b.ts', 'full', 1000, 100)
    recordReadAndBuildNudge(taskState, '/abs/c.ts', 'full', 1000, 100)

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'x', isError: false }
      },
    })

    // Long run after the gate fires — verify only 1 inject.
    const responses = [
      ...Array.from({ length: 7 }, (_, i) => toolUseResponse('read', `tool-${i + 1}`, { path: `/abs/${'abc'[i % 3]}.ts` })),
      textResponse('done'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const notices: string[] = []
    await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onNotice(n) { notices.push(n) } },
    })

    const productionGateNotices = notices.filter((n) => /^Production gate:/.test(n))
    expect(productionGateNotices).toHaveLength(1)
    const injectedUserTurns = conv.turns.filter(
      (t) =>
        t.role === 'user'
        && Array.isArray(t.content)
        && t.content.some((c: any) => c.type === 'text' && /\[Runtime production gate\]/.test(c.text)),
    )
    expect(injectedUserTurns).toHaveLength(1)
  })
})

describe('ArtifactVerify repair policy wiring', () => {
  it('injects a repair prompt into the next loop turn when ArtifactVerify fails', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Review whether /tmp/deck.html passes ArtifactVerify; do not edit files.')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'ArtifactVerify',
      description: 'fake ArtifactVerify',
      async execute() {
        const verification = failedArtifactVerification('/tmp/deck.html')
        return {
          output: JSON.stringify(verification, null, 2),
          isError: false,
          metadata: { result: verification },
        }
      },
    })

    const requestBodies: Array<Record<string, unknown>> = []
    const responses = [
      toolUseResponse('ArtifactVerify', 'tool-1', {
        packId: 'html_deck',
        deckPath: '/tmp/deck.html',
        expectedSections: 46,
      }),
      textResponse('The deck needs the section_count repair before verification can pass.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return responses.shift()!
    })

    const notices: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      maxIterations: 3,
      callbacks: { onNotice: (message) => notices.push(message) },
    })

    expect(result.stopReason).toBe('end_turn')
    expect(requestBodies).toHaveLength(2)

    const followupMessages = requestBodies[1]?.['messages'] as Array<Record<string, unknown>>
    const followupText = JSON.stringify(followupMessages)
    expect(followupText).toContain('[Runtime artifact repair]')
    expect(followupText).toContain('ArtifactVerify failed for /tmp/deck.html. Repair attempt 1/2.')
    expect(followupText).toContain('Artifact path: /tmp/deck.html')
    expect(followupText).toContain('Failed checkIds: section_count')
    expect(followupText).toContain('expected 46 sections, got 45')
    expect(followupText).toContain('After fixing, run ArtifactVerify/TaskVerify again')
    expect(notices.some((notice) => /^Artifact repair: ArtifactVerify failed/.test(notice))).toBe(true)
  })

  it('caps repair prompts per artifact path and emits a blocked signal after max attempts', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Review whether /tmp/deck.html passes ArtifactVerify; do not edit files.')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'ArtifactVerify',
      description: 'fake ArtifactVerify',
      async execute() {
        const verification = failedArtifactVerification('/tmp/deck.html')
        return {
          output: JSON.stringify(verification, null, 2),
          isError: false,
          metadata: { result: verification },
        }
      },
    })

    const responses = [
      toolUseResponse('ArtifactVerify', 'tool-1', {
        packId: 'html_deck',
        deckPath: '/tmp/deck.html',
        expectedSections: 46,
      }),
      toolUseResponse('ArtifactVerify', 'tool-2', {
        packId: 'html_deck',
        deckPath: '/tmp/deck.html',
        expectedSections: 46,
      }),
      toolUseResponse('ArtifactVerify', 'tool-3', {
        packId: 'html_deck',
        deckPath: '/tmp/deck.html',
        expectedSections: 46,
      }),
      textResponse('Blocked acknowledged.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      maxIterations: 5,
      callbacks: { onError: (message) => errors.push(message) },
    })

    expect(result.stopReason).toBe('end_turn')

    const runtimeTexts = conv.turns.flatMap((turn) =>
      turn.role === 'user'
        ? turn.content
          .filter((block: any) => block.type === 'text')
          .map((block: any) => String(block.text))
        : [],
    )
    const repairPrompts = runtimeTexts.filter((text) => text.includes('[Runtime artifact repair]'))
    const blockedPrompts = runtimeTexts.filter((text) => text.includes('[Runtime artifact repair blocked]'))

    expect(repairPrompts).toHaveLength(2)
    expect(repairPrompts[0]).toContain('Repair attempt 1/2')
    expect(repairPrompts[1]).toContain('Repair attempt 2/2')
    expect(blockedPrompts).toHaveLength(1)
    expect(blockedPrompts[0]).toContain('after 2/2 repair prompt(s)')
    expect(blockedPrompts[0]).toContain('Failed checkIds: section_count')
    expect(errors.some((message) => /^Artifact repair blocked:/.test(message))).toBe(true)
  })
})

describe('task execution nudge wiring (Slice 4)', () => {
  beforeEach(() => {
    resetTaskStore()
  })

  afterEach(() => {
    resetTaskStore()
    delete process.env['OWLCODA_PHASE_RUNTIME']
  })

  it('injects completion_blocked through the conversation loop for high-confidence code changes with open structured steps', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Implement the scheduler fix in `src/native/scheduler.ts` and update `tests/native/scheduler.test.ts`.')
    const task = createTask({
      subject: 'Scheduler fix',
      description: 'Patch scheduler behavior and cover it with a native test.',
      steps: [
        { title: 'Patch scheduler', description: 'Modify scheduler code and update coverage.' },
      ],
    })

    const dispatcher = new ToolDispatcher()
    dispatcher.register(createTaskUpdateTool())

    const requestBodies: Array<Record<string, unknown>> = []
    const responses = [
      textResponse('Final report: task complete. Tests passed. Files changed: src/native/scheduler.ts. No blockers.'),
      toolUseResponse('TaskUpdate', 'tool-1', {
        taskId: task.id,
        stepId: 'step-1',
        stepStatus: 'in_progress',
      }),
      toolUseResponse('TaskUpdate', 'tool-2', {
        taskId: task.id,
        stepId: 'step-1',
        stepStatus: 'completed',
        touchedPaths: ['/tmp/project/src/native/scheduler.ts'],
      }),
      textResponse('The scheduler fix is complete with the required task step closed.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return responses.shift()!
    })

    const notices: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      maxIterations: 6,
      callbacks: {
        onNotice(message) {
          notices.push(message)
        },
      },
    })

    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toContain('required task step closed')
    expect(notices.some((n) => /^Task-step nudge \(completion_blocked\):/.test(n))).toBe(true)

    const followupMessages = requestBodies[1]?.['messages'] as Array<Record<string, unknown>>
    const followupText = JSON.stringify(followupMessages)
    expect(followupText).toContain('[Runtime task-step]')
    expect(followupText).toContain('You claimed completion')
    expect(followupText).toContain('open required steps')
    expect(followupText).toContain('Call TaskUpdate or TaskVerify')
  })

  it('injects a missing TaskCreate plan nudge for durable artifact tasks before more broad reading', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Write the generated deck to docs/deck.html')

    const requestBodies: Array<Record<string, unknown>> = []
    const responses = [
      textResponse('I will first inspect a few more files before writing.'),
      toolUseResponse('TaskCreate', 'tool-1', {
        subject: 'Build deck',
        description: 'Create and verify the requested deck artifact.',
        steps: [
          { title: 'Write deck', description: 'Create docs/deck.html' },
          { title: 'Verify deck', description: 'Run TaskVerify checks' },
        ],
      }),
      textResponse('TaskCreate plan is in place.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return responses.shift()!
    })

    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      maxIterations: 4,
    })

    expect(result.stopReason).toBe('end_turn')
    if (gateV2EnabledForTest()) {
      expect(requestBodies).toHaveLength(1)
      expect(JSON.stringify(conv.turns)).not.toContain('[Runtime task-step]')
      return
    }
    const followupMessages = requestBodies[1]?.['messages'] as Array<Record<string, unknown>>
    const followupText = JSON.stringify(followupMessages)
    expect(followupText).toContain('[Runtime task-step]')
    expect(followupText).toContain('Call TaskCreate')
    expect(followupText).toContain('TaskVerify')
  })

  it.each([
    ['read_only_review', 'Review the scheduler code and tell me what is wrong. Do not modify files.'],
    ['text_deliverable', 'Write a technical plan in chat for how to approach scheduler behavior.'],
  ])('does not inject create-plan task-step nudges for %s deliverables', async (_mode, prompt) => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, prompt)
    createTask({
      subject: 'Open review task',
      description: 'An existing structured task that should not force plan creation for chat-only work.',
      steps: [
        { title: 'Review only', description: 'Keep this as a pending required step.' },
      ],
    })

    const requestBodies: Array<Record<string, unknown>> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return textResponse('Here is the requested review or summary.')
    })

    const notices: string[] = []
    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      maxIterations: 3,
      callbacks: {
        onNotice(message) {
          notices.push(message)
        },
      },
    })

    expect(result.stopReason).toBe('end_turn')
    expect(requestBodies.length).toBeGreaterThanOrEqual(1)
    expect(notices.some((n) => /^Task-step nudge \(create_plan\):/.test(n))).toBe(false)
    expect(JSON.stringify(conv.turns)).not.toContain('[Runtime task-step]')
  })

  it('phase runtime suppresses generic continue nudges after verification evidence report', async () => {
    process.env['OWLCODA_PHASE_RUNTIME'] = '1'

    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Write the generated deck to docs/deck.html and verify it before reporting.')
    const task = createTask({
      subject: 'Build deck',
      description: 'Create and verify the requested deck artifact.',
      steps: [
        { title: 'Write deck', description: 'Create docs/deck.html' },
      ],
    })
    updateTaskStep(task.id, 'step-1', { status: 'in_progress' })

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'DeliveryAudit',
      description: 'stub audit',
      async execute() {
        return { output: 'DeliveryAudit: verified docs/deck.html exists and has 12 sections', isError: false }
      },
    })

    const requestBodies: Array<Record<string, unknown>> = []
    const responses = [
      toolUseResponse('DeliveryAudit', 'tool-audit', { claims: ['verified docs/deck.html'] }),
      textResponse('Verification report: docs/deck.html exists and has 12 sections. Ready to finalize.'),
      textResponse('Unexpected extra model turn after runtime nudge.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return responses.shift()!
    })

    const notices: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      maxIterations: 4,
      callbacks: {
        onNotice(message) {
          notices.push(message)
        },
      },
    })

    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toContain('Verification report')
    expect(requestBodies).toHaveLength(2)
    expect(notices.some((n) => /Continue-while-open/.test(n))).toBe(false)
    expect(notices.some((n) => /^Task-step nudge \(continue_step\):/.test(n))).toBe(false)
    expect(JSON.stringify(conv.turns)).not.toContain('[Runtime task-step]')
  })
})

// 0.13.67 introduced a task-no-progress hard ceiling. 0.14.54 demotes that
// signal to advisory by default because "no writes yet" is not a runtime fact
// proving a loop. The legacy hard stop remains behind
// OWLCODA_TASK_NO_PROGRESS_HARD_STOP=1 for operators who explicitly want it.
describe('task-no-progress advisory / legacy hard ceiling', () => {
  beforeEach(() => {
    process.env['OWLCODA_AGENTIC_MODE'] = 'strict'
    delete process.env['OWLCODA_TASK_NO_PROGRESS_HARD_STOP']
  })
  afterEach(() => {
    delete process.env['OWLCODA_AGENTIC_MODE']
    delete process.env['OWLCODA_TASK_NO_PROGRESS_HARD_STOP']
  })

  it('defaults to advisory at iter 9 when task requires writes and 0 paths touched', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Write the engineering contract intake document to docs/intake.md')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'file contents', isError: false }
      },
    })

    // 9 successful Read iterations — model investigates a lot but never writes.
    // The old guard would hard-stop at iter 9; the new default only emits an
    // advisory and keeps the loop available for a later budget/identity guard.
    const responses = [
      ...Array.from({ length: 9 }, (_, i) =>
        toolUseResponse('read', `tool-${i + 1}`, { path: `/tmp/file-${i + 1}.ts` })
      ),
      textResponse('I have enough context to proceed.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const notices: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      maxIterations: 12,
      callbacks: {
        onError(e) { errors.push(e) },
        onNotice(n) { notices.push(n) },
      },
    })

    expect(result.stopReason).not.toBe('task_no_progress')
    expect(errors.some((e) => /task no-progress hard stop/.test(e))).toBe(false)
    expect(notices.some((n) => /No-progress is advisory by default/.test(n))).toBe(true)
  })

  it('legacy env hard-stops at iter 9 when task requires writes and 0 paths touched', async () => {
    process.env['OWLCODA_TASK_NO_PROGRESS_HARD_STOP'] = '1'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Write the engineering contract intake document to docs/intake.md')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'file contents', isError: false }
      },
    })

    const responses = Array.from({ length: 9 }, (_, i) =>
      toolUseResponse('read', `tool-${i + 1}`, { path: `/tmp/file-${i + 1}.ts` })
    )
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(result.stopReason).toBe('task_no_progress')
    expect(errors.some((e) => /task no-progress hard stop/.test(e))).toBe(true)
    expect(errors.some((e) => /iterations elapsed under a write-/.test(e))).toBe(true)
    expect(errors.some((e) => /0 touched paths/.test(e))).toBe(true)
    // Friendliness: the message must explain that reads/task-tracker calls do not
    // count as progress, and must name the escape hatch so a user with a
    // legitimately long-setup task can raise the budget instead of being stuck.
    expect(errors.some((e) => /written or edited/.test(e))).toBe(true)
    expect(errors.some((e) => /OWLCODA_TASK_NO_PROGRESS_ITER_LIMIT/.test(e))).toBe(true)
  })

  it('clears the no-progress budget when it hard-stops, so an inherited count cannot re-kill a follow-up turn', async () => {
    process.env['OWLCODA_TASK_NO_PROGRESS_HARD_STOP'] = '1'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Write the engineering contract intake document to docs/intake.md')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'file contents', isError: false }
      },
    })

    const responses = Array.from({ length: 9 }, (_, i) =>
      toolUseResponse('read', `tool-${i + 1}`, { path: `/tmp/file-${i + 1}.ts` })
    )
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError() {} },
    })

    if (gateV2EnabledForTest()) {
      expect(result.stopReason).not.toBe('task_no_progress')
      return
    }
    expect(result.stopReason).toBe('task_no_progress')
    // 1b: lifetimeIterations is monotonic and SHARED across user turns within
    // one task (it deliberately survives in-turn auto-retries — 0.13.67). If it
    // is not cleared when the guard hard-stops, the NEXT user turn (e.g. "why
    // did you stop?") inherits the >8 count and re-fires the guard within 1-2
    // iterations — the user can't even ask a follow-up. task_no_progress does
    // not auto-continue (it sets no runtimeFailure → shouldScheduleRuntimeAutoRetry
    // returns false), so clearing the budget at the stop only ever affects a
    // later user-driven turn, never an automatic re-entry.
    expect(result.conversation.options?.taskState?.run.lifetimeIterations).toBe(0)
  })

  it('does NOT hard-stop at iter 9 when the read ledger shows distinct-file investigation', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Fix the bug in src/native/conversation.ts')
    if (!conv.options) conv.options = {}
    const taskState = ensureTaskExecutionState(conv)
    conv.options.taskState = taskState

    recordReadAndBuildNudge(taskState, '/abs/strategy-a.ts', 'full', 1000, 100)
    recordReadAndBuildNudge(taskState, '/abs/strategy-b.ts', 'full', 1000, 100)
    recordReadAndBuildNudge(taskState, '/abs/strategy-c.ts', 'full', 1000, 100)

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'code contents', isError: false }
      },
    })

    const responses = [
      ...Array.from({ length: 9 }, (_, i) =>
        toolUseResponse('read', `tool-${i + 1}`, { path: `/tmp/src-${i + 1}.ts` })
      ),
      textResponse('I found the likely edit point and need one more confirmation before writing.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const notices: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      maxIterations: 12,
      callbacks: {
        onError(e) { errors.push(e) },
        onNotice(n) { notices.push(n) },
      },
    })

    expect(result.stopReason).not.toBe('task_no_progress')
    expect(errors.some((e) => /task no-progress hard stop/.test(e))).toBe(false)
    expect(notices.some((n) => /distinct read-ledger files indicate active investigation/.test(n))).toBe(true)
  })

  it('still hard-stops at iter 9 when the read ledger only shows repeated same-file reading', async () => {
    process.env['OWLCODA_TASK_NO_PROGRESS_HARD_STOP'] = '1'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Fix the bug in src/native/conversation.ts')
    if (!conv.options) conv.options = {}
    const taskState = ensureTaskExecutionState(conv)
    conv.options.taskState = taskState

    recordReadAndBuildNudge(taskState, '/abs/repeated.ts', 'full', 1000, 100)
    recordReadAndBuildNudge(taskState, '/abs/repeated.ts', 'full', 1000, 100)
    recordReadAndBuildNudge(taskState, '/abs/repeated.ts', 'full', 1000, 100)

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'code contents', isError: false }
      },
    })

    const responses = Array.from({ length: 9 }, (_, i) =>
      toolUseResponse('read', `tool-${i + 1}`, { path: `/tmp/src-${i + 1}.ts` })
    )
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    if (gateV2EnabledForTest()) {
      expect(result.stopReason).not.toBe('task_no_progress')
      expect(errors.some((e) => /task no-progress hard stop/.test(e))).toBe(false)
      return
    }
    expect(result.stopReason).toBe('task_no_progress')
    expect(errors.some((e) => /task no-progress hard stop/.test(e))).toBe(true)
  })

  it('does NOT hard-stop in plan mode before any touched path exists', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Plan the fix for src/native/conversation.ts before changing files.')
    if (!conv.options) conv.options = {}
    conv.options.operatingModeState = { mode: 'plan' }

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'code contents', isError: false }
      },
    })

    const responses = [
      ...Array.from({ length: 9 }, (_, i) =>
        toolUseResponse('read', `tool-${i + 1}`, { path: `/tmp/plan-${i + 1}.ts` })
      ),
      textResponse('Plan: inspect the guard predicate, patch the suppression condition, then test it.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      maxIterations: 12,
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(result.stopReason).not.toBe('task_no_progress')
    expect(errors.some((e) => /task no-progress hard stop/.test(e))).toBe(false)
  })

  it('does NOT hard-stop at iter 9 after a failed bash call created a scratch artifact', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Write the generated deck to docs/deck.html')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'source material', isError: false }
      },
    })
    dispatcher.register({
      name: 'bash',
      description: 'test bash',
      async execute(_input: any) {
        return {
          output: 'SyntaxError: invalid syntax',
          isError: true,
          metadata: { exitCode: 1 },
        }
      },
    })
    dispatcher.register({
      name: 'write',
      description: 'test write',
      async execute(input: any) {
        return {
          output: `wrote ${String(input.path ?? '')}`,
          isError: false,
          metadata: { path: String(input.path ?? '') },
        }
      },
    })

    const scratch = '/tmp/gen_ppt.py'
    const responses = [
      ...Array.from({ length: 7 }, (_, i) =>
        toolUseResponse('read', `tool-read-${i + 1}`, { path: `/tmp/source-${i + 1}.md` })
      ),
      toolUseResponse('bash', 'tool-bash-generator', {
        command: `cat > "${scratch}" << 'PYEOF'\nprint("draft")\nPYEOF\npython "${scratch}"`,
      }),
      toolUseResponse('write', 'tool-write-deck', {
        path: 'docs/deck.html',
        content: '<!doctype html><title>deck</title>',
      }),
      textResponse('Done after repairing the generator and writing docs/deck.html.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(result.stopReason).not.toBe('task_no_progress')
    expect(errors.some((e) => /task no-progress hard stop/.test(e))).toBe(false)
    expect(result.conversation.options?.taskState?.run.scratchArtifactPaths?.some((path) => path.endsWith('/gen_ppt.py'))).toBe(true)
    expect(result.conversation.options?.taskState?.contract.touchedPaths).toContain(`${process.cwd()}/docs/deck.html`)
  })

  it('does NOT fire when task does not require writes (analysis intent)', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, '解释一下这段代码做什么')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'code lines', isError: false }
      },
    })

    // 12 read iterations under analysis-only task — should NOT trip
    // the no-progress ceiling because taskHasWriteRequiredContract is
    // false. Analysis tasks are allowed to be read-heavy.
    const responses = Array.from({ length: 11 }, (_, i) =>
      toolUseResponse('read', `tool-${i + 1}`, { path: `/tmp/code-${i + 1}.ts` })
    )
    responses.push(textResponse('Here is the analysis: ...'))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
    })

    expect(result.stopReason).not.toBe('task_no_progress')
  })

  it('does NOT fire for architecture/code-quality evaluation phrased with 写的', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, '这个项目的 业务架构设计如何，代码写的是否健壮可扩展可维护')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'architecture notes', isError: false }
      },
    })

    const responses = [
      ...Array.from({ length: 11 }, (_, i) =>
        toolUseResponse('read', `tool-${i + 1}`, { path: `/tmp/architecture-${i + 1}.md` })
      ),
      textResponse('结论：业务架构有清晰分层，代码健壮性和可维护性还有若干风险。'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(e) { errors.push(e) },
      },
    })

    expect(result.stopReason).not.toBe('task_no_progress')
    expect(errors.some((e) => /task no-progress hard stop/.test(e))).toBe(false)
    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toContain('业务架构')
  })

  it('does NOT treat read-only prohibitions plus a final text report as write-required', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, [
      '你是 MES + OpenClaw 查询链路的探索式红队测试员。',
      '硬性限制：只读查询，不允许创建、修改、删除 MES 数据。',
      '第五阶段：按以下结构输出测试报告。',
    ].join('\n'))

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'readonly evidence', isError: false }
      },
    })

    const responses = [
      ...Array.from({ length: 10 }, (_, i) =>
        toolUseResponse('read', `tool-${i + 1}`, { path: `/tmp/readonly-${i + 1}.md` })
      ),
      textResponse('最终报告\n\n1. 系统能力地图\n2. 测试素材库\n3. 问题清单'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const notices: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(e) { errors.push(e) },
        onNotice(n) { notices.push(n) },
      },
    })

    expect(result.stopReason).not.toBe('task_no_progress')
    expect(errors.some((e) => /task no-progress hard stop/.test(e))).toBe(false)
    expect(notices.some((n) => /Production gate/.test(n))).toBe(false)
    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toContain('最终报告')
  })

  it('does NOT treat English no-mutation QA report prompts as write-required', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, [
      'Run exploratory QA.',
      'Read-only only: do not create, modify, or delete MES data.',
      'Output a final report with findings and reproduction steps.',
    ].join('\n'))

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'readonly evidence', isError: false }
      },
    })

    const responses = [
      ...Array.from({ length: 10 }, (_, i) =>
        toolUseResponse('read', `tool-${i + 1}`, { path: `/tmp/readonly-en-${i + 1}.md` })
      ),
      textResponse('Final report\n\nFindings: none reproduced in this bounded run.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(result.stopReason).not.toBe('task_no_progress')
    expect(errors.some((e) => /task no-progress hard stop/.test(e))).toBe(false)
    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toContain('Final report')
  })
})

// 0.14.54: narration-loop is identity-based. It hard-stops exact repeated
// text-only replies, not "write task + no touched paths" narration.
describe('narration-loop detector (identity-based)', () => {
  beforeEach(() => {
    process.env['OWLCODA_AGENTIC_MODE'] = 'strict'
  })
  afterEach(() => {
    delete process.env['OWLCODA_AGENTIC_MODE']
  })

  it('hard-terminates after 3 identical text-only replies', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Write the engineering contract intake document to docs/intake.md')

    // Three identical text-only replies. This is a true identity loop.
    const responses = [
      textResponse('Now I have all the source material. Let me write the document.'),
      textResponse('Now I have all the source material. Let me write the document.'),
      textResponse('Now I have all the source material. Let me write the document.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(result.stopReason).toBe('narration_loop')
    expect(errors.some((e) => /narration loop/.test(e))).toBe(true)
    expect(errors.some((e) => /same text-only reply 3 consecutive times/.test(e))).toBe(true)
    expect(errors.some((e) => /Use \/retry, \/model to switch/.test(e))).toBe(true)
  })

  it('does NOT terminate on different text-only replies', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Write the document to docs/x.md')

    const responses = [
      textResponse('Let me write the document.'),
      textResponse('Now ready, let me write.'),
      // Third response breaks the chain by ending with a real
      // commitment to stop / ask user (no tool call still, but the
      // conversation flow lets it exit naturally — task hits
      // continue-while-open cap and breaks via the !hasToolUse path).
    ]
    let fallbackCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (responses.length === 0) {
        fallbackCount += 1
        return textResponse(`Stopping; need user direction ${fallbackCount}.`)
      }
      return responses.shift()!
    })

    const errors: string[] = []
    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      maxIterations: 6,
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(result.stopReason).not.toBe('narration_loop')
    expect(errors.some((e) => /narration loop/.test(e))).toBe(false)
  })

  it('resets the counter when the model emits a tool_use iteration', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Write the document to docs/x.md')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'file contents', isError: false }
      },
    })

    // identical narration → identical narration → tool_use (Read, resets
    // counter) → identical narration 3x. Only the post-tool identity chain
    // should trip.
    const repeated = 'Now I have the context. Let me write.'
    const responses = [
      textResponse(repeated),                                  // identity 1
      textResponse(repeated),                                  // identity 2
      toolUseResponse('read', 'tool-1', { path: '/tmp/x.md' }), // RESETS counter
      textResponse(repeated),                                  // identity 1 (post-reset)
      textResponse(repeated),                                  // identity 2
      textResponse(repeated),                                  // identity 3 → terminates
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(result.stopReason).toBe('narration_loop')
  })

  it('does not keep non-write tasks alive just to detect repeated text', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, '解释一下这段代码做什么')

    const responses = [
      textResponse('I need to think about this.'),
      textResponse('I need to think about this.'),
      textResponse('I need to think about this.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
    })

    expect(result.stopReason).not.toBe('narration_loop')
  })
})

// 0.13.64: max-tokens continuation nudge. Detects stop_reason=
// max_tokens and injects a [Runtime max-tokens continuation] user-
// role turn telling the model to resume from cut-off or switch to
// file-based delivery. Cap at 2 injects per consecutive run.
describe('max-tokens continuation nudge (0.13.64)', () => {
  beforeEach(() => {
    delete process.env['OWLCODA_AGENTIC_MODE']
  })

  it('injects a continuation nudge when first response stops at max_tokens', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Write a long thing')

    // Response 1: max_tokens. Response 2: end_turn (model resumes
    // and finishes).
    const responses = [
      contentResponse([{ type: 'text', text: 'Partial content cut off here' }], 'tool_use' as any),
      textResponse('Resumed and finished.'),
    ]
    // contentResponse helper above takes stop_reason as 2nd arg —
    // we need 'max_tokens'. Build it directly:
    responses[0] = new Response(JSON.stringify({
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content: [{ type: 'text', text: 'Partial content cut off here' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 5, output_tokens: 100 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const notices: string[] = []
    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onNotice: (n) => notices.push(n) },
    })

    expect(notices.some((n) => /Max-tokens continuation/.test(n))).toBe(true)
    expect(result.stopReason).toBe('end_turn')
    // The conversation has the inject as a user-role turn after the
    // truncated assistant turn.
    const sawInject = conv.turns.some((turn) =>
      turn.role === 'user' && turn.content.some((b: any) =>
        b?.type === 'text' && /Runtime max-tokens continuation/.test(String(b?.text ?? ''))
      )
    )
    expect(sawInject).toBe(true)
  })

  it('escalates wording on second consecutive truncation', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Write a long thing')

    const responses = [
      new Response(JSON.stringify({
        type: 'message', role: 'assistant', model: 'test-model',
        content: [{ type: 'text', text: 'truncate one' }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 5, output_tokens: 100 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
      new Response(JSON.stringify({
        type: 'message', role: 'assistant', model: 'test-model',
        content: [{ type: 'text', text: 'truncate two' }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 5, output_tokens: 100 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
      // Third response succeeds so the loop ends.
      textResponse('OK switching to file-based delivery.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
    })

    expect(result.stopReason).toBe('end_turn')
    // Inspect the second inject body — should say "last 2 replies"
    const injectBodies: string[] = []
    for (const turn of conv.turns) {
      if (turn.role !== 'user') continue
      for (const b of turn.content as any[]) {
        if (b?.type === 'text' && /Runtime max-tokens continuation/.test(String(b?.text ?? ''))) {
          injectBodies.push(b.text)
        }
      }
    }
    expect(injectBodies.length).toBe(2)
    expect(injectBodies[0]).toMatch(/Continue from where you left off/)
    expect(injectBodies[1]).toMatch(/last 2 replies hit stop_reason=max_tokens/)
    expect(injectBodies[1]).toMatch(/Stop trying to render the full deliverable inline/)
  })

  it('caps at MAX_TOKENS_CONTINUATION_LIMIT (2) injects per consecutive run', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Write a long thing')

    // 4 max_tokens in a row, then end_turn. Should only inject 2x.
    const responses = [
      ...Array.from({ length: 4 }, (_, i) =>
        new Response(JSON.stringify({
          type: 'message', role: 'assistant', model: 'test-model',
          content: [{ type: 'text', text: `truncate ${i}` }],
          stop_reason: 'max_tokens',
          usage: { input_tokens: 5, output_tokens: 100 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      ),
      textResponse('Done.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const notices: string[] = []
    await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onNotice: (n) => notices.push(n) },
    })

    const injectCount = conv.turns.filter((turn) =>
      turn.role === 'user' && turn.content.some((b: any) =>
        b?.type === 'text' && /Runtime max-tokens continuation/.test(String(b?.text ?? ''))
      )
    ).length
    expect(injectCount).toBe(2)
    expect(notices.filter((n) => /Max-tokens continuation/.test(n)).length).toBe(2)
  })

  it('resets the counter after a non-max_tokens response (end_turn between truncations)', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'first')

    // truncate, end_turn, truncate again — should fire INJECT for both
    // truncations because the counter resets.
    const responses = [
      new Response(JSON.stringify({
        type: 'message', role: 'assistant', model: 'test-model',
        content: [{ type: 'text', text: 'truncate A' }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 5, output_tokens: 100 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
      textResponse('done first round'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
    })

    // After end_turn the counter resets. If we fed another max_tokens
    // now (separate user input), it would inject again. But within this
    // single runConversationLoop call we just verify the first run had
    // a single inject (because the chain was truncate → end_turn).
    const injectCount = conv.turns.filter((turn) =>
      turn.role === 'user' && turn.content.some((b: any) =>
        b?.type === 'text' && /Runtime max-tokens continuation/.test(String(b?.text ?? ''))
      )
    ).length
    expect(injectCount).toBe(1)
  })
})

// 0.13.62 (B): dispatcher-level schema-failure short-circuit.
// Long-context kimi/deepseek emit `write({})` repeatedly past the
// 0.13.55 soft loop intercept because the empty-input intentKey
// degenerates and dodges dedupe. New defense: track (toolName,
// missingFieldsList) — second occurrence hard-terminates BEFORE
// running the tool.
describe('schema-fail dispatcher short-circuit (0.13.62)', () => {
  beforeEach(() => {
    process.env['OWLCODA_AGENTIC_MODE'] = 'strict'
  })
  afterEach(() => {
    delete process.env['OWLCODA_AGENTIC_MODE']
  })

  it('hard-terminates after the SECOND write({}) call with same missing fields', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'write a file')

    const dispatcher = new ToolDispatcher()
    let writeCalls = 0
    dispatcher.register({
      name: 'write',
      description: 'test write',
      async execute(_input: any) {
        writeCalls++
        return { output: 'wrote', isError: false }
      },
    })

    // Two consecutive write({}) emissions. The first hits the
    // schema-error path inside the write tool itself; the second is
    // pre-empted at the dispatcher level by the 0.13.62 short-circuit.
    const responses = [
      toolUseResponse('write', 'tool-1', {}),
      toolUseResponse('write', 'tool-2', {}),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(result.stopReason).toBe('tool_loop')
    expect(errors.some((e) => /repeated schema failures/.test(e))).toBe(true)
    expect(errors.some((e) => /Hard-terminating to break the empty-input retry loop/.test(e))).toBe(true)
    // First-strike: pre-flight check increments counter to 1, tool
    // runs (mock dispatcher returns success). Second-strike:
    // priorCount is 1 → short-circuit, tool NOT run. So mock execute
    // is called exactly once.
    expect(writeCalls).toBe(1)
  })

  it('does NOT short-circuit on first write({}) — only on the second-strike', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'write a file')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'write',
      description: 'test write',
      async execute(_input: any) {
        return { output: 'ok', isError: false }
      },
    })

    // One write({}) followed by an end_turn text response. First
    // attempt should be allowed to fail at the schema-error level
    // (model gets a chance to recover), no hard terminate yet.
    const responses = [
      toolUseResponse('write', 'tool-1', {}),
      textResponse('Sorry, I will retry with the right fields next time.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    // First-strike schema fail does NOT hard terminate.
    expect(result.stopReason).toBe('end_turn')
    expect(errors.some((e) => /repeated schema failures/.test(e))).toBe(false)
  })

  it('does NOT short-circuit when subsequent write has DIFFERENT missing fields', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'write a file')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'write',
      description: 'test write',
      async execute(_input: any) {
        return { output: 'ok', isError: false }
      },
    })

    // First call: missing both. Second call: only missing `content`.
    // Different missingFields → different dedup key → no short-circuit.
    const responses = [
      toolUseResponse('write', 'tool-1', {}),
      toolUseResponse('write', 'tool-2', { path: '/tmp/x' }),
      textResponse('Done.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(result.stopReason).toBe('end_turn')
    expect(errors.some((e) => /repeated schema failures/.test(e))).toBe(false)
  })
})

// 0.14.18: contract.confidence + fail-open downgrade.
// confidence='high' (in-workspace explicit paths) → legacy hard-stop if explicitly enabled.
// confidence='medium' (external-only explicit paths, no ALLOW phrasing) → no hard-stop.
// confidence='low' (workspace mode) → no hard-stop.
describe('contract.confidence fail-open gate (0.14.18)', () => {
  beforeEach(() => {
    process.env['OWLCODA_AGENTIC_MODE'] = 'strict'
    delete process.env['OWLCODA_TASK_NO_PROGRESS_HARD_STOP']
  })
  afterEach(() => {
    delete process.env['OWLCODA_AGENTIC_MODE']
    delete process.env['OWLCODA_TASK_NO_PROGRESS_HARD_STOP']
  })

  it('confidence=high (in-cwd explicit path): legacy env hard-stops at iter 9 with 0 touched', async () => {
    process.env['OWLCODA_TASK_NO_PROGRESS_HARD_STOP'] = '1'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    // "docs/intake.md" resolves to in-cwd explicit scope → confidence=high
    addUserMessage(conv, 'Write the engineering contract to docs/intake.md')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'file contents', isError: false }
      },
    })

    const responses = Array.from({ length: 9 }, (_, i) =>
      toolUseResponse('read', `tool-${i + 1}`, { path: `/tmp/file-${i + 1}.ts` })
    )
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    if (gateV2EnabledForTest()) {
      expect(result.stopReason).not.toBe('task_no_progress')
      expect(errors.some((e) => /task no-progress hard stop/.test(e))).toBe(false)
      return
    }
    expect(result.stopReason).toBe('task_no_progress')
    expect(errors.some((e) => /task no-progress hard stop/.test(e))).toBe(true)
  })

  it('confidence=medium (external explicit path, no ALLOW phrasing): does NOT hard-stop at iter 9', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    // Absolute external path mentioned in backticks without ALLOW phrasing →
    // confidence=medium (bug-2 handoff case pattern).
    // Prompt uses "write" to trigger taskHasWriteRequiredContract=true.
    addUserMessage(
      conv,
      'Write the slide deck referencing `/Users/publicuser/work/ppt/deck-stage.js`',
    )

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'file contents', isError: false }
      },
    })

    const notices: string[] = []
    // 10 iterations → would trigger hard-stop if confidence=high
    const responses = [
      ...Array.from({ length: 9 }, (_, i) =>
        toolUseResponse('read', `tool-${i + 1}`, { path: `/tmp/ref-${i + 1}.md` })
      ),
      textResponse('Done reading. Here is my analysis.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(e) { errors.push(e) },
        onNotice(n) { notices.push(n) },
      },
    })

    expect(result.stopReason).not.toBe('task_no_progress')
    expect(errors.some((e) => /task no-progress hard stop/.test(e))).toBe(false)
    // Suppressed notice should appear
    expect(notices.some((n) => /task no-progress suppressed/.test(n))).toBe(true)
  })

  it('emits the no-progress advisory at most once per task, not once per iteration', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    // Write-required contract. The advisory fires on the demoted (default) path
    // regardless of scope confidence.
    addUserMessage(conv, 'Write the slide deck referencing `/Users/publicuser/work/ppt/deck-stage.js`')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'file contents', isError: false }
      },
    })

    // 14 distinct reads keep the task in the no-progress advisory zone for many
    // iterations past the >8 threshold (iter 9..14) without touching a path.
    // Before the one-shot guard the advisory onNotice fired on every one of
    // those turns; it must now fire exactly once per task.
    const notices: string[] = []
    const responses = [
      ...Array.from({ length: 14 }, (_, i) =>
        toolUseResponse('read', `tool-${i + 1}`, { path: `/tmp/ref-${i + 1}.md` })
      ),
      textResponse('Done reading. Here is my analysis.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      maxIterations: 25,
      callbacks: { onNotice(n) { notices.push(n) } },
    })

    expect(result.stopReason).not.toBe('task_no_progress') // demoted to advisory by default
    const advisories = notices.filter((n) => /task no-progress suppressed/.test(n))
    expect(advisories.length).toBe(1) // one-shot per task, not per iteration
  })

  it('confidence=low (workspace mode): does NOT hard-stop at iter 9', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    // No explicit write targets → workspace mode → confidence=low
    addUserMessage(conv, 'Analyze the codebase and suggest improvements')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'file contents', isError: false }
      },
    })

    const responses = [
      ...Array.from({ length: 9 }, (_, i) =>
        toolUseResponse('read', `tool-${i + 1}`, { path: `/tmp/src-${i + 1}.ts` })
      ),
      textResponse('Analysis complete.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(result.stopReason).not.toBe('task_no_progress')
    expect(errors.some((e) => /task no-progress hard stop/.test(e))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Slice 0 Deliverable Contract v1 — gate policy integration tests (0.14.18+)
// ---------------------------------------------------------------------------

describe('Slice 0 deliverable contract: read_only_review tasks are NOT hard-stopped', () => {
  beforeEach(() => {
    process.env['OWLCODA_AGENTIC_MODE'] = 'strict'
    delete process.env['OWLCODA_LOOP_GUARD']
  })
  afterEach(() => {
    delete process.env['OWLCODA_AGENTIC_MODE']
    delete process.env['OWLCODA_LOOP_GUARD']
  })

  it('read-only review prompt: 9+ read iterations with 0 touched paths does NOT task_no_progress', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    // Explicit read-only review signal: no file write required, answer in chat
    addUserMessage(conv, '只读评审，在聊天中输出，不要求写文件')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'file contents for review', isError: false }
      },
    })

    // 11 read iterations + final text — should NOT trigger task_no_progress
    const responses = [
      ...Array.from({ length: 11 }, (_, i) =>
        toolUseResponse('read', `tool-${i + 1}`, { path: `/tmp/review-${i + 1}.ts` })
      ),
      textResponse('评审结果：代码结构清晰，发现以下 5 个改进点。'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const notices: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(e) { errors.push(e) },
        onNotice(n) { notices.push(n) },
      },
    })

    expect(result.stopReason).not.toBe('task_no_progress')
    expect(errors.some((e) => /task no-progress hard stop/.test(e))).toBe(false)
    expect(result.stopReason).toBe('end_turn')
  })

  it('text_deliverable prompt: 9+ iterations with 0 touched paths does NOT task_no_progress', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    // Text deliverable: write tech plan in chat (no file path)
    addUserMessage(conv, '写一份技术方案')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'reference material', isError: false }
      },
    })

    const responses = [
      ...Array.from({ length: 10 }, (_, i) =>
        toolUseResponse('read', `tool-${i + 1}`, { path: `/tmp/ref-${i + 1}.md` })
      ),
      textResponse('技术方案如下：\n\n## 目标\n...\n\n## 实施步骤\n...'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(result.stopReason).not.toBe('task_no_progress')
    expect(errors.some((e) => /task no-progress hard stop/.test(e))).toBe(false)
  })
})

describe('Slice 0 deliverable contract: file artifact legacy hard-stop', () => {
  beforeEach(() => {
    process.env['OWLCODA_AGENTIC_MODE'] = 'strict'
    delete process.env['OWLCODA_LOOP_GUARD']
    delete process.env['OWLCODA_TASK_NO_PROGRESS_HARD_STOP']
  })
  afterEach(() => {
    delete process.env['OWLCODA_AGENTIC_MODE']
    delete process.env['OWLCODA_LOOP_GUARD']
    delete process.env['OWLCODA_TASK_NO_PROGRESS_HARD_STOP']
  })

  it('fails open for incident-shaped artifact prompts that only provide reference paths and suggested filenames', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(
      conv,
      [
        '先读 /Users/publicuser/AI/OwlManage/docs/prompts/industrial-ai-agent-ppt-v1.4-new-executor-full-rebuild-prompt-20260514.md',
        '再读 /Users/publicuser/work/ppt/claude-design-input-v1.3.1/06-new-executor-v1.4-full-rebuild.md',
        '目标产物：46 页 HTML PPT + build notes',
        '只交付：',
        '1. HTML',
        '   建议文件名：`工业AI-Agent-v1.4-content-rebuild-46p.html`',
        '2. build notes',
        '   建议文件名：`build-notes-v1.4-content-rebuild-46p.md`',
      ].join('\n'),
    )

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'source material', isError: false }
      },
    })

    const responses = [
      ...Array.from({ length: 9 }, (_, i) =>
        toolUseResponse('read', `tool-${i + 1}`, { path: `/tmp/material-${i + 1}.md` })
      ),
      textResponse('I still need a concrete output path before I can safely write artifacts.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const notices: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      maxIterations: 12,
      callbacks: {
        onError(e) { errors.push(e) },
        onNotice(n) { notices.push(n) },
      },
    })

    expect(result.stopReason).not.toBe('task_no_progress')
    expect(errors.some((e) => /task no-progress hard stop/.test(e))).toBe(false)
    expect(notices.some((n) => /task no-progress suppressed/.test(n))).toBe(true)
  })

  it('file_artifact_delivery/high: legacy env makes 9+ iterations with 0 touched paths task_no_progress', async () => {
    process.env['OWLCODA_TASK_NO_PROGRESS_HARD_STOP'] = '1'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    // Explicit write to file: file_artifact_delivery/high
    addUserMessage(conv, 'Write the deck to /Users/publicuser/work/ppt/output/owlcoda/deck.html')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'source material', isError: false }
      },
    })

    // 9 read iterations, no writes — should hard-stop
    const responses = Array.from({ length: 9 }, (_, i) =>
      toolUseResponse('read', `tool-${i + 1}`, { path: `/tmp/material-${i + 1}.md` })
    )
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    if (gateV2EnabledForTest()) {
      expect(result.stopReason).not.toBe('task_no_progress')
      expect(errors.some((e) => /task no-progress hard stop/.test(e))).toBe(false)
      return
    }
    expect(result.stopReason).toBe('task_no_progress')
    expect(errors.some((e) => /task no-progress hard stop/.test(e))).toBe(true)
  })

  it('file_artifact_delivery/high: bash setup artifacts keep production eval runs out of false task_no_progress', async () => {
    const outputRoot = join(tmpdir(), `owlcoda-prod-eval-${Date.now()}`)
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, `Generate an HTML deck and build notes to ${outputRoot}/`)

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'source material', isError: false }
      },
    })
    dispatcher.register({
      name: 'bash',
      description: 'test bash',
      async execute(_input: any) {
        return { output: 'setup complete', isError: false }
      },
    })

    const responses = [
      ...Array.from({ length: 7 }, (_, i) =>
        toolUseResponse('read', `tool-${i + 1}`, { path: `/tmp/material-${i + 1}.md` })
      ),
      toolUseResponse('bash', 'tool-8', {
        command: [
          `export EVAL_ROOT="${outputRoot}"`,
          'export EVIDENCE_DIR="$EVAL_ROOT/evidence"',
          'mkdir -p "$EVAL_ROOT"/{owlcoda,kimi-cli,evidence}',
          'npm install -g owlcoda@latest --prefix "$EVAL_ROOT/npm-global"',
          'npm view owlcoda version --json | tee "$EVIDENCE_DIR/npm-view.json"',
        ].join('\n'),
      }),
      textResponse('Setup artifacts are ready under the output root.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      maxIterations: 10,
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(result.stopReason).not.toBe('task_no_progress')
    expect(errors.some((e) => /task no-progress hard stop/.test(e))).toBe(false)
    const touchedPaths = conv.options?.taskState?.contract.touchedPaths ?? []
    for (const suffix of [
      '/owlcoda',
      '/kimi-cli',
      '/evidence',
      '/npm-global',
      '/evidence/npm-view.json',
    ]) {
      expect(touchedPaths.some((path) => path.endsWith(`${outputRoot}${suffix}`) || path.endsWith(suffix))).toBe(true)
    }
  })

  it('code_change/high: legacy env makes 9+ iterations with 0 touched paths task_no_progress', async () => {
    process.env['OWLCODA_TASK_NO_PROGRESS_HARD_STOP'] = '1'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Fix the bug in src/native/conversation.ts')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'code contents', isError: false }
      },
    })

    const responses = Array.from({ length: 9 }, (_, i) =>
      toolUseResponse('read', `tool-${i + 1}`, { path: `/tmp/src-${i + 1}.ts` })
    )
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    if (gateV2EnabledForTest()) {
      expect(result.stopReason).not.toBe('task_no_progress')
      expect(errors.some((e) => /task no-progress hard stop/.test(e))).toBe(false)
      return
    }
    expect(result.stopReason).toBe('task_no_progress')
    expect(errors.some((e) => /task no-progress hard stop/.test(e))).toBe(true)
  })
})

describe('Slice 0 deliverable contract: mixed_unknown does NOT hard-stop (fail-open)', () => {
  beforeEach(() => {
    process.env['OWLCODA_AGENTIC_MODE'] = 'strict'
    delete process.env['OWLCODA_LOOP_GUARD']
  })
  afterEach(() => {
    delete process.env['OWLCODA_AGENTIC_MODE']
    delete process.env['OWLCODA_LOOP_GUARD']
  })

  it('zero-signal prompt (mixed_unknown): 9+ iterations with 0 touched paths does NOT task_no_progress', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    // 'continue' → mixed_unknown/low
    addUserMessage(conv, '继续')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'data', isError: false }
      },
    })

    const responses = [
      ...Array.from({ length: 10 }, (_, i) =>
        toolUseResponse('read', `tool-${i + 1}`, { path: `/tmp/x-${i + 1}.ts` })
      ),
      textResponse('Done.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const notices: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(e) { errors.push(e) },
        onNotice(n) { notices.push(n) },
      },
    })

    expect(result.stopReason).not.toBe('task_no_progress')
    expect(errors.some((e) => /task no-progress hard stop/.test(e))).toBe(false)
    // Suppressed notice should appear (not hard-stop)
    // The telemetry suppress path fires, not break
  })
})

describe('Slice 0 deliverable contract: text_deliverable can durable complete', () => {
  beforeEach(() => {
    process.env['OWLCODA_AGENTIC_MODE'] = 'strict'
    delete process.env['OWLCODA_LOOP_GUARD']
  })
  afterEach(() => {
    delete process.env['OWLCODA_AGENTIC_MODE']
    delete process.env['OWLCODA_LOOP_GUARD']
  })

  it('text_deliverable: final chat output is accepted as durable completion (end_turn, not blocked)', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, '写技术方案')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'reference material', isError: false }
      },
    })

    const responses = [
      toolUseResponse('read', 'tool-1', { path: '/tmp/ref.md' }),
      textResponse('技术方案：\n\n1. 目标\n2. 方案\n3. 实施步骤'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(result.stopReason).toBe('end_turn')
    expect(errors.some((e) => /task no-progress hard stop/.test(e))).toBe(false)
  })
})
