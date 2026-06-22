/**
 * 0.13.98 Batch B — llm-compact unit + integration tests.
 *
 * Verifies the bounded compactor input shape, the validation contract on
 * structured-header output, and the tryCompact orchestrator behavior under:
 *   - LLM success
 *   - LLM HTTP error
 *   - LLM timeout
 *   - LLM empty / too short response
 *   - LLM output missing structured headers
 *   - LLM output containing tool_use markers
 *   - 3-strike disable + reset on success
 *   - heap_pressure path NEVER calls LLM
 *   - no_op when conversation is too small
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  buildCompactionFidelityEvents,
  buildCompactionRequest,
  compactViaLLM,
  extractErrorEvidence,
  extractFilePaths,
  extractToolCallSummary,
  findLatestNonMetaUserText,
  serializeTurnsForCompactor,
  tryCompact,
  validateCompactionOutput,
  RECENT_TURNS_VERBATIM_COUNT,
  REQUIRED_HEADERS,
  MAX_CONSECUTIVE_LLM_COMPACT_FAILURES,
  COMPACTION_LOG_MAX_ENTRIES,
} from '../../src/native/llm-compact.js'
import type { Conversation, ConversationTurn } from '../../src/native/protocol/types.js'
import type { GateEvent } from '../../src/native/gate-telemetry.js'

// ─── helpers ──────────────────────────────────────────────────────────

function userTurn(text: string): ConversationTurn {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }
}

function assistantTurn(text: string): ConversationTurn {
  return { role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now() }
}

function toolUseTurn(name: string, input: Record<string, unknown>, id = 'tool-1'): ConversationTurn {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
    timestamp: Date.now(),
  }
}

function toolResultTurn(id: string, content: string, isError = false): ConversationTurn {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    timestamp: Date.now(),
  }
}

function makeConv(turns: ConversationTurn[], system = 'test system'): Conversation {
  return {
    id: 'test-conv',
    system,
    turns,
    tools: [],
    model: 'test-model',
    maxTokens: 1000,
  }
}

async function withTempOwlCodaHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'owlcoda-compact-fidelity-test-'))
  const previousHome = process.env['OWLCODA_HOME']
  process.env['OWLCODA_HOME'] = home
  try {
    return await fn(home)
  } finally {
    if (previousHome === undefined) {
      delete process.env['OWLCODA_HOME']
    } else {
      process.env['OWLCODA_HOME'] = previousHome
    }
    await rm(home, { recursive: true, force: true })
  }
}

async function readTelemetryEvents(home: string): Promise<GateEvent[]> {
  const date = new Date().toISOString().slice(0, 10)
  const contents = await readFile(join(home, 'telemetry', `gate-events-${date}.jsonl`), 'utf8')
  return contents.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as GateEvent)
}

// ─── extractors ───────────────────────────────────────────────────────

describe('findLatestNonMetaUserText', () => {
  it('returns most recent plain user text turn', () => {
    const turns = [
      userTurn('first'),
      assistantTurn('reply 1'),
      userTurn('second'),
    ]
    expect(findLatestNonMetaUserText(turns)).toBe('second')
  })

  it('skips "继续"/"continue" recovery shapes', () => {
    const turns = [
      userTurn('real goal'),
      assistantTurn('reply'),
      userTurn('继续'),
    ]
    expect(findLatestNonMetaUserText(turns)).toBe('real goal')
  })

  it('skips [Runtime ...] meta turns', () => {
    const turns = [
      userTurn('real goal'),
      assistantTurn('reply'),
      userTurn('[Runtime context-pressure check]\nSomething.'),
    ]
    expect(findLatestNonMetaUserText(turns)).toBe('real goal')
  })

  it('skips pure-punctuation turns', () => {
    const turns = [userTurn('real goal'), userTurn('?')]
    expect(findLatestNonMetaUserText(turns)).toBe('real goal')
  })

  it('skips tool_result-only user turns (no plain text)', () => {
    const turns = [
      userTurn('real goal'),
      toolResultTurn('t-1', 'output'),
    ]
    expect(findLatestNonMetaUserText(turns)).toBe('real goal')
  })

  it('returns null when no eligible turn exists', () => {
    expect(findLatestNonMetaUserText([userTurn('继续'), userTurn('?')])).toBe(null)
  })
})

describe('extractToolCallSummary', () => {
  it('builds one line per (tool_use, tool_result) pair', () => {
    const turns = [
      toolUseTurn('Read', { path: '/a.ts' }, 'id-a'),
      toolResultTurn('id-a', 'file contents'),
      toolUseTurn('Bash', { cmd: 'ls' }, 'id-b'),
      toolResultTurn('id-b', 'a\nb\nc'),
    ]
    const out = extractToolCallSummary(turns)
    expect(out).toContain('Read({"path":"/a.ts"})')
    expect(out).toContain('→ ok')
    expect(out).toContain('Bash({"cmd":"ls"})')
  })

  it('marks tool_error explicitly', () => {
    const turns = [
      toolUseTurn('Read', { path: '/missing' }, 'id-c'),
      toolResultTurn('id-c', 'file not found', true),
    ]
    expect(extractToolCallSummary(turns)).toContain('→ err')
  })

  it('caps at maxLines (most-recent-N tail)', () => {
    const turns: ConversationTurn[] = []
    for (let i = 0; i < 60; i++) {
      turns.push(toolUseTurn('Read', { idx: i }, `id-${i}`))
      turns.push(toolResultTurn(`id-${i}`, `out ${i}`))
    }
    const out = extractToolCallSummary(turns, 10)
    const lines = out.split('\n')
    expect(lines.length).toBe(10)
    // Last entry should be the most recent (idx=59).
    expect(lines[lines.length - 1]).toContain('"idx":59')
  })
})

describe('extractErrorEvidence', () => {
  it('captures is_error tool_results', () => {
    const turns = [toolResultTurn('id-1', 'file not found', true)]
    expect(extractErrorEvidence(turns)).toContain('tool_error: file not found')
  })

  it('captures [Runtime ...] warnings from text turns', () => {
    const turns = [userTurn('[Runtime guard] write blocked outside scope')]
    expect(extractErrorEvidence(turns)).toContain('runtime:')
  })

  it('captures timeout / context_exceeded phrasing', () => {
    const turns = [
      assistantTurn('Request timed out after 120s. Retrying.'),
    ]
    const out = extractErrorEvidence(turns)
    expect(out).toContain('failure:')
  })
})

describe('extractFilePaths', () => {
  it('extracts string path-like values from tool_use inputs', () => {
    const turns = [
      toolUseTurn('Read', { path: 'src/foo.ts' }, 'id-1'),
      toolUseTurn('Edit', { file_path: '/abs/bar.ts', old_string: 'x' }, 'id-2'),
    ]
    const paths = extractFilePaths(turns)
    expect(paths).toContain('src/foo.ts')
    expect(paths).toContain('/abs/bar.ts')
  })

  it('rejects strings with shell metachars or whitespace', () => {
    const turns = [
      toolUseTurn('Bash', { cmd: 'rm -rf /tmp/x' }, 'id-1'),
    ]
    expect(extractFilePaths(turns)).toEqual([])
  })

  it('dedups paths', () => {
    const turns = [
      toolUseTurn('Read', { path: 'src/a.ts' }, 'id-1'),
      toolUseTurn('Read', { path: 'src/a.ts' }, 'id-2'),
    ]
    expect(extractFilePaths(turns)).toEqual(['src/a.ts'])
  })

  it('caps at maxPaths', () => {
    const turns: ConversationTurn[] = []
    for (let i = 0; i < 200; i++) {
      turns.push(toolUseTurn('Read', { path: `src/f${i}.ts` }, `id-${i}`))
    }
    expect(extractFilePaths(turns, 50).length).toBe(50)
  })
})

describe('serializeTurnsForCompactor', () => {
  it('formats user / assistant / tool_use / tool_result distinctly', () => {
    const turns = [
      userTurn('hello'),
      toolUseTurn('Read', { path: 'a.ts' }, 'id-1'),
      toolResultTurn('id-1', 'file body'),
      assistantTurn('reply'),
    ]
    const out = serializeTurnsForCompactor(turns, 1000)
    expect(out).toContain('[user] hello')
    expect(out).toContain('(tool_use: Read')
    expect(out).toContain('(tool_result:')
    expect(out).toContain('[assistant] reply')
  })

  it('drops oldest turns when over token cap', () => {
    const turns = Array.from({ length: 20 }, (_, i) => userTurn(`turn-${i} `.repeat(50)))
    const out = serializeTurnsForCompactor(turns, 100)
    expect(out).not.toContain('turn-0 ')
    expect(out).toContain('turn-19')
  })
})

// ─── 8-section request builder ────────────────────────────────────────

describe('buildCompactionRequest', () => {
  it('returns null when conversation is at-or-below recent-keep size', () => {
    const conv = makeConv([userTurn('hi'), assistantTurn('hello')])
    expect(buildCompactionRequest(conv)).toBeNull()
  })

  it('splits into droppedTurns + keptTurns at RECENT_TURNS_VERBATIM_COUNT boundary', () => {
    const turns = Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0 ? userTurn(`q${i}`) : assistantTurn(`a${i}`),
    )
    const conv = makeConv(turns)
    const req = buildCompactionRequest(conv)!
    expect(req.keptTurns.length).toBe(RECENT_TURNS_VERBATIM_COUNT)
    expect(req.droppedTurns.length).toBe(turns.length - RECENT_TURNS_VERBATIM_COUNT)
  })

  it('includes all 8 section headers in the prompt', () => {
    const turns = [
      userTurn('what is 2+2?'),
      assistantTurn('4'),
      toolUseTurn('Read', { path: 'a.ts' }, 'id-1'),
      toolResultTurn('id-1', 'file body', false),
      userTurn('next q'),
      assistantTurn('next a'),
      userTurn('the latest goal'),
      assistantTurn('working on it'),
    ]
    const conv = makeConv(turns)
    const req = buildCompactionRequest(conv)!
    expect(req.prompt).toContain('[system]')
    expect(req.prompt).toContain('[latest_user_goal]')
    expect(req.prompt).toContain('[task_contract_anchor]')
    expect(req.prompt).toContain('[recent_turns_verbatim]')
    expect(req.prompt).toContain('[tool_call_summary]')
    expect(req.prompt).toContain('[error_evidence]')
    expect(req.prompt).toContain('[file_paths_touched]')
  })

  it('truncates over-cap system with a hash marker (system never dropped)', () => {
    const longSystem = 'x'.repeat(100_000)
    const turns = Array.from({ length: 10 }, () => userTurn('q'))
    const conv = makeConv(turns, longSystem)
    const req = buildCompactionRequest(conv)!
    expect(req.prompt).toContain('[system truncated:')
    expect(req.prompt).toMatch(/sha256:[0-9a-f]{7}/)
    expect(req.prompt).toContain('chars omitted')
  })

  it('includes latest_user_goal verbatim when under cap', () => {
    const goal = 'rewrite the auth module'
    const turns = [
      userTurn('old context'), assistantTurn('ok'),
      userTurn('older context'), assistantTurn('ok'),
      userTurn('older still'), assistantTurn('ok'),
      userTurn(goal), assistantTurn('working'),
    ]
    const conv = makeConv(turns)
    const req = buildCompactionRequest(conv)!
    expect(req.prompt).toContain(goal)
  })

  it('includes task contract anchor when latest user text is only runtime recovery', () => {
    const initialPrompt = [
      '请并发 subagent 生成四个 1200-1500 字段落。',
      '只能输出到 /Users/publicuser/AI/gitrep/owlmodel/out/full。',
      '不碰 8066/8029 cutover。',
      '最终报告必须列出证据路径。',
    ].join('\n')
    const conv = makeConv([
      userTurn(initialPrompt),
      assistantTurn('开始核对代理和目录。'),
      toolUseTurn('Read', { path: '/Users/publicuser/AI/gitrep/owlmodel/README.md' }, 'read-1'),
      toolResultTurn('read-1', 'README body'),
      assistantTurn('发现已有污染，需要分片生成。'),
      userTurn('你一直在忙活什么？'),
      assistantTurn('我在继续跑。'),
      userTurn('批准啊，你来做'),
      assistantTurn('收到，继续。'),
    ])
    conv.options = {
      taskState: {
        contract: {
          version: 1,
          sourceTurnHash: 'h',
          sourceText: initialPrompt,
          objective: initialPrompt,
          dominantGap: 'produce shard files and evidence report',
          cwd: '/Users/publicuser/AI/gitrep/owlmodel',
          scopeMode: 'explicit_paths',
          explicitWriteTargets: ['/Users/publicuser/AI/gitrep/owlmodel/out/full'],
          allowedWritePaths: [{
            path: '/Users/publicuser/AI/gitrep/owlmodel/out/full',
            kind: 'directory',
            origin: 'explicit',
          }],
          touchedPaths: [],
          createdAt: 0,
          updatedAt: 0,
          confidence: 'high',
        },
        run: {
          status: 'waiting_user',
          iterations: 8,
          lifetimeIterations: 12,
          productionGateFired: true,
          scratchArtifactPaths: [],
          currentFocus: 'waiting on write-scope approval for shard outputs',
          lastProgressAt: 0,
          lastGuardReason: 'Task contract blocked write to /Users/publicuser/AI/gitrep/owlmodel/out/full/shard-01.md.',
          pendingWriteApproval: {
            attemptedPaths: [
              '/Users/publicuser/AI/gitrep/owlmodel/out/full/shard-01.md',
              '/Users/publicuser/AI/gitrep/owlmodel/out/full/shard-02.md',
            ],
            requestedAt: 0,
          },
          runWorkspace: null,
          lastUpdatedAt: 0,
        },
        proposedToolCalls: [],
        phaseEvents: [],
      },
    }

    const req = buildCompactionRequest(conv, { recentTurnsCount: 4 })!

    expect(req.prompt).toContain('[task_contract_anchor]')
    expect(req.prompt).toContain('请并发 subagent')
    expect(req.prompt).toContain('1200-1500')
    expect(req.prompt).toContain('/Users/publicuser/AI/gitrep/owlmodel/out/full')
    expect(req.prompt).toContain('/Users/publicuser/AI/gitrep/owlmodel/out/full/shard-02.md')
    expect(req.prompt).toContain('Task contract blocked write')
  })
})

// ─── output validation ───────────────────────────────────────────────

describe('validateCompactionOutput', () => {
  const goodOutput = `Current goal: rebuild auth.

Preserved evidence:
- src/auth.ts touched
- decided to use JWT

Recent actions:
- Read src/auth.ts
- Edit applied

Open risks:
- session migration not done
`

  it('accepts output with all 4 required headers', () => {
    expect(validateCompactionOutput(goodOutput).ok).toBe(true)
  })

  it('rejects missing any of the 4 headers', () => {
    for (const header of REQUIRED_HEADERS) {
      const stripped = goodOutput.replace(header, 'XXX')
      const result = validateCompactionOutput(stripped)
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('missing_header')
    }
  })

  it('rejects empty / under 50 chars', () => {
    expect(validateCompactionOutput('').ok).toBe(false)
    expect(validateCompactionOutput('OK').reason).toBe('too_short')
  })

  it('rejects > 8000 chars', () => {
    const long = 'Current goal Preserved evidence Recent actions Open risks ' + 'x'.repeat(9000)
    expect(validateCompactionOutput(long).reason).toBe('too_long')
  })

  it('rejects tool_use markers (compactor must not hallucinate tools)', () => {
    const withTool = goodOutput + '\n<tool_use>{"name":"Read"}</tool_use>'
    expect(validateCompactionOutput(withTool).reason).toBe('tool_use_marker')
    const withJson = goodOutput + '\n{"type": "tool_use", "name": "Read"}'
    expect(validateCompactionOutput(withJson).reason).toBe('tool_use_marker')
  })

  it('header check is case-insensitive', () => {
    const lower = goodOutput.toLowerCase()
    expect(validateCompactionOutput(lower).ok).toBe(true)
  })
})

describe('buildCompactionFidelityEvents', () => {
  it('emits exact path preservation facts for compaction summaries', () => {
    const dropped = [
      toolUseTurn('Read', { path: 'src/native/conversation.ts' }, 'read-1'),
      toolResultTurn('read-1', 'file contents'),
    ]

    const events = buildCompactionFidelityEvents(dropped, {
      summary: 'Current goal:\nContinue.\n\nPreserved evidence:\n- src/native/conversation.ts was read.\n\nRecent actions:\n- Read ran.\n\nOpen risks:\n- none.',
      conversationId: 'conv-fidelity',
      iteration: 4,
      model: 'test-model',
      lastToolSignatures: ['Read:path:src/native/conversation.ts'],
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'fidelity_compaction_fact_observed',
      conversationId: 'conv-fidelity',
      iteration: 4,
      factType: 'path',
      target: 'src/native/conversation.ts',
      sourceTurnId: 'dropped:0',
      afterMatch: true,
      preserved: true,
      reason: 'kept',
      compactionFactReason: 'kept',
      model: 'test-model',
      phase: 'compact',
    })
    expect(events[0]!.beforeHash).toMatch(/^sha256:[a-f0-9]{12}$/)
  })

  it('marks exact path facts as dropped when the summary omits them', () => {
    const dropped = [
      toolUseTurn('Read', { path: 'src/native/project-map.ts' }, 'read-1'),
      toolResultTurn('read-1', 'file contents'),
    ]

    const events = buildCompactionFidelityEvents(dropped, {
      summary: 'Current goal:\nContinue.\n\nPreserved evidence:\n- a project file was read.\n\nRecent actions:\n- Read ran.\n\nOpen risks:\n- none.',
      conversationId: 'conv-fidelity',
      iteration: 5,
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      factType: 'path',
      target: 'src/native/project-map.ts',
      afterMatch: false,
      preserved: false,
      reason: 'dropped',
      compactionFactReason: 'dropped',
    })
  })

  it('does not count a path prefix as an exact preserved fact', () => {
    const dropped = [
      toolUseTurn('Read', { path: 'src/native/project-map.ts' }, 'read-1'),
      toolResultTurn('read-1', 'file contents'),
    ]

    const events = buildCompactionFidelityEvents(dropped, {
      summary: 'Current goal:\nContinue.\n\nPreserved evidence:\n- src/native/project-map.ts.bak was mentioned.\n\nRecent actions:\n- Read ran.\n\nOpen risks:\n- none.',
      conversationId: 'conv-fidelity',
      iteration: 6,
    })

    expect(events).toHaveLength(1)
    expect(events[0]!.afterMatch).toBe(false)
  })
})

// ─── compactViaLLM (mocked fetch) ────────────────────────────────────

const validSummary = `Current goal: refactor auth module.

Preserved evidence:
- src/auth.ts has 200 lines, touched 3 times

Recent actions:
- Read src/auth.ts
- Edit applied successfully

Open risks:
- session token migration is still pending
`

function mockFetch(response: { status?: number; body?: any; reject?: Error; delay?: number }): typeof fetch {
  return (async (_url: string, init?: { signal?: AbortSignal }) => {
    if (response.delay) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, response.delay)
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          const e = new Error('aborted')
          e.name = 'AbortError'
          reject(e)
        })
      })
    }
    if (response.reject) throw response.reject
    return {
      ok: (response.status ?? 200) >= 200 && (response.status ?? 200) < 300,
      status: response.status ?? 200,
      json: async () => response.body,
    } as Response
  }) as unknown as typeof fetch
}

describe('compactViaLLM', () => {
  it('success: returns summary and ok=true', async () => {
    const conv = makeConv(Array.from({ length: 8 }, () => userTurn('q')))
    const req = buildCompactionRequest(conv)!
    const result = await compactViaLLM(req, {
      apiBaseUrl: 'http://x',
      apiKey: 'k',
      model: 'm',
      fetchImpl: mockFetch({
        body: { content: [{ type: 'text', text: validSummary }] },
      }),
    })
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('Current goal')
  })

  it('http error: ok=false with error message', async () => {
    const conv = makeConv(Array.from({ length: 8 }, () => userTurn('q')))
    const req = buildCompactionRequest(conv)!
    const result = await compactViaLLM(req, {
      apiBaseUrl: 'http://x', apiKey: 'k', model: 'm',
      fetchImpl: mockFetch({ status: 503, body: {} }),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('503')
  })

  it('validation fail: missing headers → ok=false', async () => {
    const conv = makeConv(Array.from({ length: 8 }, () => userTurn('q')))
    const req = buildCompactionRequest(conv)!
    // Long enough to pass too_short, but no required headers.
    const noHeaders = 'This is a long unstructured summary paragraph without any of the required section labels at all. It just rambles about the conversation.'
    const result = await compactViaLLM(req, {
      apiBaseUrl: 'http://x', apiKey: 'k', model: 'm',
      fetchImpl: mockFetch({
        body: { content: [{ type: 'text', text: noHeaders }] },
      }),
    })
    expect(result.ok).toBe(false)
    expect(result.validationReason).toBe('missing_header')
  })

  it('network reject: ok=false', async () => {
    const conv = makeConv(Array.from({ length: 8 }, () => userTurn('q')))
    const req = buildCompactionRequest(conv)!
    const result = await compactViaLLM(req, {
      apiBaseUrl: 'http://x', apiKey: 'k', model: 'm',
      fetchImpl: mockFetch({ reject: new Error('ECONNREFUSED') }),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('ECONNREFUSED')
  })
})

// ─── tryCompact orchestrator ─────────────────────────────────────────

describe('tryCompact', () => {
  const baseTurns = (n: number): ConversationTurn[] => Array.from({ length: n }, (_, i) =>
    i % 2 === 0 ? userTurn(`q${i}`) : assistantTurn(`a${i}`),
  )

  it('LLM success → method=llm_summary, conversation.turns replaced with summary + kept', async () => {
    const conv = makeConv(baseTurns(10))
    const result = await tryCompact(conv, {
      reason: 'threshold',
      apiBaseUrl: 'http://x',
      truncationKeepCount: 4,
      fetchImpl: mockFetch({ body: { content: [{ type: 'text', text: validSummary }] } }),
    })
    expect(result.method).toBe('llm_summary')
    expect(conv.turns[0]!.content[0]).toMatchObject({ type: 'text' })
    const summaryText = (conv.turns[0]!.content[0] as any).text as string
    expect(summaryText).toContain('Conversation compacted')
    expect(summaryText).toContain('Current goal')
    expect(conv.turns.length).toBe(1 + RECENT_TURNS_VERBATIM_COUNT)
    expect(conv.options?.llmCompactFailureCount).toBe(0)
  })

  it('LLM success installs a context replacement checkpoint with digest and replacement history', async () => {
    const conv = makeConv(baseTurns(10))
    const result = await tryCompact(conv, {
      reason: 'threshold',
      apiBaseUrl: 'http://x',
      truncationKeepCount: 4,
      fetchImpl: mockFetch({ body: { content: [{ type: 'text', text: validSummary }] } }),
    })

    const checkpoint = conv.options?.runtimeRecoveryLedger?.checkpoints
      .find((item) => item.kind === 'context_replacement_checkpoint')
    const contextReplacement = checkpoint?.payload.context_replacement as any

    expect(result.method).toBe('llm_summary')
    expect(checkpoint?.disposition).toBe('active')
    expect(contextReplacement).toMatchObject({
      reason: 'threshold',
      window_id: 'threshold',
      ledger_status: 'active',
      replacement_history: conv.turns,
    })
    expect(contextReplacement.input_history_digest).toMatch(/^sha256:/)
    expect(conv.options?.runtimeEventLog?.events.some((event) =>
      event.kind === 'checkpoint_installed'
      && event.checkpointKind === 'context_replacement_checkpoint',
    )).toBe(true)
    expect(conv.options?.runtimeEventLog?.events).toContainEqual(expect.objectContaining({
      kind: 'runtime_intervention',
      checkpointKind: 'context_replacement_checkpoint',
      payload: expect.objectContaining({
        intervention_kind: 'context_compaction_result',
        action: 'context_compaction_completed',
        compaction_reason: 'threshold',
        compaction_method: 'llm_summary',
        before_turns: 10,
        after_turns: 1 + RECENT_TURNS_VERBATIM_COUNT,
        llm_attempted: true,
      }),
    }))
  })

  it('LLM success writes reviewable compaction fidelity telemetry', async () => {
    await withTempOwlCodaHome(async (home) => {
      const conv = makeConv([
        toolUseTurn('Read', { path: 'src/native/project-map.ts' }, 'read-1'),
        toolResultTurn('read-1', 'project map contents'),
        toolUseTurn('Read', { path: 'src/native/nonexistent-ledger.ts' }, 'read-2'),
        toolResultTurn('read-2', 'missing file result'),
        userTurn('continue with compaction fixture'),
        assistantTurn('ack'),
        userTurn('keep recent one'),
        assistantTurn('recent answer one'),
        userTurn('keep recent two'),
        assistantTurn('recent answer two'),
      ])
      const summary = `Current goal: continue the compaction fidelity fixture.

Preserved evidence:
- src/native/project-map.ts was read before compaction.

Recent actions:
- Recent turns were kept verbatim.

Open risks:
- The missing ledger path is intentionally not preserved.
`

      const result = await tryCompact(conv, {
        reason: 'threshold',
        apiBaseUrl: 'http://x',
        truncationKeepCount: 4,
        fidelityTelemetry: {
          conversationId: 'conv-compact-fidelity',
          iteration: 14,
          lastToolSignatures: ['read:read:src/native/project-map.ts'],
          model: 'compact-test-model',
        },
        fetchImpl: mockFetch({ body: { content: [{ type: 'text', text: summary }] } }),
      })

      expect(result.method).toBe('llm_summary')
      const events = await readTelemetryEvents(home)
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'fidelity_compaction_fact_observed',
        conversationId: 'conv-compact-fidelity',
        iteration: 14,
        factType: 'path',
        target: 'src/native/project-map.ts',
        afterMatch: true,
        preserved: true,
        reason: 'kept',
        compactionFactReason: 'kept',
        model: 'compact-test-model',
        phase: 'compact',
      }))
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'fidelity_compaction_fact_observed',
        target: 'src/native/nonexistent-ledger.ts',
        afterMatch: false,
        preserved: false,
        reason: 'dropped',
        compactionFactReason: 'dropped',
      }))
    })
  })

  it('LLM failure → method=truncation, fallbackReason=llm_compact_failed, strike counter ++', async () => {
    const conv = makeConv(baseTurns(10))
    const result = await tryCompact(conv, {
      reason: 'threshold',
      apiBaseUrl: 'http://x',
      truncationKeepCount: 4,
      fetchImpl: mockFetch({ status: 500, body: {} }),
    })
    expect(result.method).toBe('truncation')
    expect(result.fallbackReason).toBe('llm_compact_failed')
    expect(conv.options?.llmCompactFailureCount).toBe(1)
    expect(conv.turns.length).toBe(4)
    expect(conv.options?.runtimeEventLog?.events).toContainEqual(expect.objectContaining({
      kind: 'runtime_intervention',
      checkpointKind: 'context_replacement_checkpoint',
      payload: expect.objectContaining({
        intervention_kind: 'context_compaction_result',
        action: 'context_compaction_fallback',
        compaction_reason: 'threshold',
        compaction_method: 'truncation',
        fallback_reason: 'llm_compact_failed',
        before_turns: 10,
        after_turns: 4,
        llm_attempted: true,
        llm_compact_failure_count: 1,
      }),
    }))
  })

  it('3-strike disable: with failureCount=3, skips LLM and truncates with disabled reason', async () => {
    const conv = makeConv(baseTurns(10))
    conv.options = { llmCompactFailureCount: 3 }
    let fetchCalled = false
    const fetchSpy: typeof fetch = ((..._args: unknown[]) => {
      fetchCalled = true
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) }) as unknown as Promise<Response>
    }) as typeof fetch
    const result = await tryCompact(conv, {
      reason: 'threshold',
      apiBaseUrl: 'http://x',
      truncationKeepCount: 4,
      fetchImpl: fetchSpy,
    })
    expect(fetchCalled).toBe(false) // never called
    expect(result.method).toBe('truncation')
    expect(result.fallbackReason).toBe('llm_compact_disabled_3strikes')
  })

  it('successful LLM compact RESETS strike counter to 0', async () => {
    const conv = makeConv(baseTurns(10))
    conv.options = { llmCompactFailureCount: 2 } // close to disable, but not yet
    await tryCompact(conv, {
      reason: 'threshold',
      apiBaseUrl: 'http://x',
      truncationKeepCount: 4,
      fetchImpl: mockFetch({ body: { content: [{ type: 'text', text: validSummary }] } }),
    })
    expect(conv.options?.llmCompactFailureCount).toBe(0)
  })

  it('heap_pressure NEVER calls LLM (sync truncation only)', async () => {
    const conv = makeConv(baseTurns(10))
    let fetchCalled = false
    const fetchSpy: typeof fetch = ((..._args: unknown[]) => {
      fetchCalled = true
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) }) as unknown as Promise<Response>
    }) as typeof fetch
    const result = await tryCompact(conv, {
      reason: 'heap_pressure',
      apiBaseUrl: 'http://x',
      truncationKeepCount: 2,
      fetchImpl: fetchSpy,
    })
    expect(fetchCalled).toBe(false)
    expect(result.method).toBe('truncation')
    expect(result.fallbackReason).toBe('heap_pressure_skip_llm')
    expect(conv.turns.length).toBe(2)
  })

  it('no apiBaseUrl → straight truncation', async () => {
    const conv = makeConv(baseTurns(10))
    const result = await tryCompact(conv, {
      reason: 'threshold',
      truncationKeepCount: 4,
    })
    expect(result.method).toBe('truncation')
    expect(result.fallbackReason).toBe('no_llm_opts')
  })

  it('truncation fallback installs a context replacement checkpoint too', async () => {
    const conv = makeConv(baseTurns(10))
    const result = await tryCompact(conv, {
      reason: 'threshold',
      truncationKeepCount: 4,
    })
    const checkpoint = conv.options?.runtimeRecoveryLedger?.checkpoints
      .find((item) => item.kind === 'context_replacement_checkpoint')
    const contextReplacement = checkpoint?.payload.context_replacement as any

    expect(result.method).toBe('truncation')
    expect(contextReplacement).toMatchObject({
      reason: 'threshold',
      window_id: 'threshold',
      ledger_status: 'active',
      replacement_history: conv.turns,
    })
    expect(contextReplacement.input_history_digest).toMatch(/^sha256:/)
  })

  it('truncation fallback preserves task contract anchor before tail turns', async () => {
    const initialPrompt = '写四个 1200-1500 字 shard，只能落盘到 /tmp/owlmodel/out/full，最后给证据报告。'
    const conv = makeConv([
      userTurn(initialPrompt),
      assistantTurn('分析任务。'),
      ...baseTurns(10),
      userTurn('批准啊，你来做'),
      assistantTurn('继续执行。'),
    ])
    conv.options = {
      taskState: {
        contract: {
          version: 1,
          sourceTurnHash: 'h',
          sourceText: initialPrompt,
          objective: initialPrompt,
          dominantGap: null,
          cwd: '/tmp/owlmodel',
          scopeMode: 'explicit_paths',
          explicitWriteTargets: ['/tmp/owlmodel/out/full'],
          allowedWritePaths: [{
            path: '/tmp/owlmodel/out/full',
            kind: 'directory',
            origin: 'explicit',
          }],
          touchedPaths: ['/tmp/owlmodel/out/full/shard-01.md'],
          createdAt: 0,
          updatedAt: 0,
          confidence: 'high',
        },
        run: {
          status: 'open',
          iterations: 9,
          lifetimeIterations: 9,
          productionGateFired: true,
          scratchArtifactPaths: [],
          currentFocus: 'generate remaining shards',
          lastProgressAt: 0,
          lastGuardReason: null,
          pendingWriteApproval: null,
          runWorkspace: null,
          lastUpdatedAt: 0,
        },
        proposedToolCalls: [],
        phaseEvents: [],
      },
    }

    const result = await tryCompact(conv, {
      reason: 'threshold',
      truncationKeepCount: 2,
    })

    expect(result.method).toBe('truncation')
    expect(conv.turns.length).toBe(3)
    const anchorText = (conv.turns[0]!.content[0] as any).text as string
    expect(anchorText).toContain('[Task contract anchor preserved across compaction]')
    expect(anchorText).toContain('1200-1500 字 shard')
    expect(anchorText).toContain('/tmp/owlmodel/out/full')
    expect(anchorText).toContain('/tmp/owlmodel/out/full/shard-01.md')
    expect((conv.turns[1]!.content[0] as any).text).toBe('批准啊，你来做')
  })

  it('conversation too small → no_op', async () => {
    const conv = makeConv(baseTurns(2))
    const result = await tryCompact(conv, {
      reason: 'threshold',
      apiBaseUrl: 'http://x',
      truncationKeepCount: 4,
      fetchImpl: mockFetch({ body: { content: [{ type: 'text', text: validSummary }] } }),
    })
    expect(result.method).toBe('no_op')
    expect(result.before).toBe(result.after)
  })

  it('compactionLog ring buffer caps at COMPACTION_LOG_MAX_ENTRIES', async () => {
    const conv = makeConv(baseTurns(10))
    for (let i = 0; i < COMPACTION_LOG_MAX_ENTRIES + 3; i++) {
      // Reset turns each iter so we keep producing compactable conversations.
      conv.turns = baseTurns(10)
      await tryCompact(conv, {
        reason: 'threshold',
        apiBaseUrl: 'http://x',
        truncationKeepCount: 4,
        fetchImpl: mockFetch({ status: 500, body: {} }),
      })
    }
    expect(conv.options?.compactionLog?.length).toBe(COMPACTION_LOG_MAX_ENTRIES)
  })

  it('contract: MAX_CONSECUTIVE_LLM_COMPACT_FAILURES === 3', () => {
    expect(MAX_CONSECUTIVE_LLM_COMPACT_FAILURES).toBe(3)
  })
})
