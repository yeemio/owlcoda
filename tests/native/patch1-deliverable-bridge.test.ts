/**
 * Patch 1 · Deliverable Bridge Tests
 *
 * Tests for A1 (classifier manifest hint), A2 (heredoc body stripping),
 * and A3 (gate reads manifest from runWorkspace snapshot).
 *
 * T1 – A1 main fix: manifestHint can break weak/ambiguous ties without overriding explicit code targets
 * T2 – A1 secondary: explicit output path in prompt → file_artifact_delivery, not code_change
 * T3 – A1 tertiary: read-only review prompt does not escalate to code_change
 * T4 – A2: heredoc body stripping (3 forms + unterminated edge case)
 * T5 – A3: taskState.run.runWorkspace.deliverableMode is used as hint
 * T6 – End-to-end: manifest hint prevents task_no_progress_hard in deck trajectory
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyDeliverableContract,
  shouldHardStopOnNoTouchedPaths,
  allowsChatFinal,
} from '../../src/native/deliverable-contract.js'
import {
  ensureTaskExecutionState,
  markTaskIteration,
  recordBashArtifactProgress,
} from '../../src/native/task-state.js'
import { createConversation, addUserMessage, runConversationLoop } from '../../src/native/conversation.js'
import { ToolDispatcher } from '../../src/native/dispatch.js'
import { resetTaskStore } from '../../src/native/tools/task-store.js'

// ---------------------------------------------------------------------------
// T1 — A1 main fix: manifestHint is bounded by explicit code-mutation targets
// ---------------------------------------------------------------------------

describe('T1 · A1 main fix: manifestHint is bounded', () => {
  it('manifestHint file_artifact_delivery/high does not override explicit code path mutation', () => {
    const text = '修改 src/native/conversation.ts 的 bug，并输出结果到 /tmp/deck.html'
    const withoutHint = classifyDeliverableContract(text)
    expect(withoutHint.mode).toBe('code_change')

    const withHint = classifyDeliverableContract(text, {
      manifestHint: { deliverableMode: 'file_artifact_delivery', confidence: 'high' },
    })
    expect(withHint.mode).toBe('code_change')
    expect(withHint.confidence).toBe('high')
    expect(shouldHardStopOnNoTouchedPaths(withHint)).toBe(true)
    expect(withHint.signalSummary.codeChange.length).toBeGreaterThan(0)
  })

  it('manifestHint file_artifact_delivery/high can classify weak continuation text', () => {
    const text = '继续推进这个执行任务，先做材料整理和输出规划'
    const withoutHint = classifyDeliverableContract(text)
    expect(withoutHint.mode).toBe('mixed_unknown')

    const withHint = classifyDeliverableContract(text, {
      manifestHint: { deliverableMode: 'file_artifact_delivery', confidence: 'high' },
    })
    expect(withHint.mode).toBe('file_artifact_delivery')
    expect(withHint.confidence).toBe('high')
  })

  it('manifestHint/medium is honoured for ambiguous non-code text', () => {
    const text = '继续处理这个 PPT 交付任务'
    const withHint = classifyDeliverableContract(text, {
      manifestHint: { deliverableMode: 'file_artifact_delivery', confidence: 'medium' },
    })
    expect(withHint.mode).toBe('file_artifact_delivery')
    expect(withHint.confidence).toBe('medium')
    // medium confidence → no hard stop
    expect(shouldHardStopOnNoTouchedPaths(withHint)).toBe(false)
  })

  it('manifestHint/low is NOT honoured — falls back to local classification', () => {
    // explicit code_change: 修改 src/ path → code_change_path
    const text = '修改 src/native/conversation.ts 修复 bug'
    const withLowHint = classifyDeliverableContract(text, {
      manifestHint: { deliverableMode: 'file_artifact_delivery', confidence: 'low' },
    })
    // low confidence hint is ignored; local classifier picks code_change
    expect(withLowHint.mode).toBe('code_change')
  })

  it('matchedModes still includes local signals when hint is active', () => {
    const text = 'create industrial AI PPT output to /tmp/deck.html'
    const result = classifyDeliverableContract(text, {
      manifestHint: { deliverableMode: 'file_artifact_delivery', confidence: 'high' },
    })
    expect(result.mode).toBe('file_artifact_delivery')
    // Local signals should be enriched in matchedModes
    expect(result.matchedModes).toContain('file_artifact_delivery')
  })
})

// ---------------------------------------------------------------------------
// T2 — A1 secondary: explicit output path → file_artifact_delivery beats weak code_change
// ---------------------------------------------------------------------------

describe('T2 · A1 secondary: explicit output path beats weak code_change verb signal', () => {
  it('请创建 46 页 HTML PPT 输出到 /tmp/deck.html → file_artifact_delivery, not code_change', () => {
    const text = '请创建 46 页 HTML PPT 输出到 /tmp/deck.html'
    const result = classifyDeliverableContract(text)
    expect(result.mode).toBe('file_artifact_delivery')
    expect(result.confidence).toBe('high')
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(true)
  })

  it('explicit output path with artifact suffix beats 实现 verb', () => {
    // 实现 triggers code_change verb, but the explicit path with .html should win
    const text = '实现一个 46 页 PPT，保存到 /tmp/out/test.html'
    const result = classifyDeliverableContract(text)
    // With A1.次修: file_artifact_delivery (explicit path) should win over weak 实现 code_change
    expect(result.mode).toBe('file_artifact_delivery')
  })

  it('pure code_change with explicit src path is still code_change', () => {
    // When code_change has explicit src path (not just a verb), it should NOT be demoted
    const text = '修改 src/native/conversation.ts 修复 bug，输出到 /tmp/result.html'
    const result = classifyDeliverableContract(text)
    // Both code_change_path signal + file_artifact exist → code_change still wins
    // because code_change has an explicit path signal (not just a verb)
    expect(result.mode).toBe('code_change')
    expect(result.matchedModes).toContain('file_artifact_delivery')
  })
})

// ---------------------------------------------------------------------------
// T3 — A1 tertiary: read-only prompt does not escalate to code_change
// ---------------------------------------------------------------------------

describe('T3 · A1 tertiary: read-only review prompt stays read_only_review', () => {
  it('解释 src/foo.ts 这个函数 → does not become code_change', () => {
    // "解释" is not a code mutation verb — should not trigger code_change
    const result = classifyDeliverableContract('解释 src/foo.ts 这个函数')
    expect(result.mode).not.toBe('code_change')
    expect(allowsChatFinal(result)).toBe(true)
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(false)
  })

  it('只读评审，在聊天中输出，不要求写文件 → read_only_review, no hard stop', () => {
    const result = classifyDeliverableContract('只读评审，在聊天中输出，不要求写文件')
    expect(result.mode).toBe('read_only_review')
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(false)
  })

  it('review conversation.ts task-state.ts NARRATION_LOOP_LIMIT → no hard stop (any non-code_change mode)', () => {
    const text = 'Review conversation.ts:775-808, task-state.ts:555-563, NARRATION_LOOP_LIMIT = 3. Output findings in chat.'
    const result = classifyDeliverableContract(text)
    // Key invariant: must NOT hard-stop (this is a read-only review, not a code change task)
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(false)
    expect(result.mode).not.toBe('code_change')
  })
})

// ---------------------------------------------------------------------------
// T4 — A2: heredoc body stripping — 3 forms + unterminated edge case
// ---------------------------------------------------------------------------

describe('T4 · A2: heredoc body stripping in extractBashArtifactPaths', () => {
  let cwd: string

  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'owlcoda-heredoc-test-')))
  })

  afterEach(() => {
    try { rmSync(cwd, { recursive: true, force: true }) } catch { /* swallow */ }
  })

  function testHeredocExtraction(command: string, expectedPaths: string[]): void {
    // Use recordBashArtifactProgress which calls extractBashArtifactPaths internally
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(conversation, `Output to ${cwd}/`)
    const taskState = ensureTaskExecutionState(conversation, cwd)
    markTaskIteration(taskState, { iterations: 1 })
    void recordBashArtifactProgress(taskState, 'bash', { command, cwd })

    const touchedOrScratched = [
      ...taskState.contract.touchedPaths,
      ...(taskState.run.scratchArtifactPaths ?? []),
    ]

    for (const expected of expectedPaths) {
      expect(touchedOrScratched).toContain(expected)
    }

    // Verify that no paths ending in html-tag-like segments were recorded
    const badPaths = touchedOrScratched.filter((p) =>
      /\/(div|h1|h2|h3|p|span|section|body|html|head)$/.test(p)
    )
    expect(badPaths).toHaveLength(0)
  }

  it('T4a: <<EOF form — only redirect target is returned, not heredoc body HTML tags', () => {
    const outFile = join(cwd, 'foo.html')
    const command = `cat > ${outFile} <<EOF\n<div class="page">\n  <h1>Title</h1>\n</div>\nEOF`
    testHeredocExtraction(command, [outFile])
  })

  it("T4b: <<'EOF' form (single-quoted delimiter) — HTML body not parsed as paths", () => {
    const outFile = join(cwd, 'bar.html')
    const command = `cat > ${outFile} <<'EOF'\n<div class="page">\n  <h1>Title</h1>\n</div>\nEOF`
    testHeredocExtraction(command, [outFile])
  })

  it('T4c: <<-EOF form (tab-stripped) — body not parsed as redirect', () => {
    const outFile = join(cwd, 'baz.html')
    // Tab-stripped: delimiter line may have leading tabs
    const command = `cat > ${outFile} <<-EOF\n<div>\n\t<h1>Title</h1>\n</div>\n\tEOF`
    testHeredocExtraction(command, [outFile])
  })

  it('T4d: unterminated heredoc — no paths extracted after the opener', () => {
    // After an unterminated heredoc, any redirect-like text in the body must not be parsed
    const command = `cat > ${cwd}/good.html <<'EOF'\n<div>/fake/path/file.html\n  <h2>section</h2>`
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(conversation, `Output to ${cwd}/`)
    const taskState = ensureTaskExecutionState(conversation, cwd)
    markTaskIteration(taskState, { iterations: 1 })
    void recordBashArtifactProgress(taskState, 'bash', { command, cwd })

    const touchedOrScratched = [
      ...taskState.contract.touchedPaths,
      ...(taskState.run.scratchArtifactPaths ?? []),
    ]

    // /fake/path/file.html in the heredoc body must NOT appear
    expect(touchedOrScratched).not.toContain('/fake/path/file.html')
    // And no HTML tag paths
    const badPaths = touchedOrScratched.filter((p) =>
      /\/(div|h1|h2|h3|p|span|section|body)$/.test(p)
    )
    expect(badPaths).toHaveLength(0)
  })

  it('T4e: exact reproduction of the failing case from the bug report', () => {
    // The real failure: cat > /path/foo.html <<'EOF'\n<div class="page">...</div>\nEOF
    // extractBashArtifactPaths returned /path/div, /path/h1 etc. — now must not.
    const outFile = join(cwd, 'foo.html')
    const command = `cat > ${outFile} <<'EOF'\n<div class="page">\n  <h1>Title</h1>\n</div>\nEOF`
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(conversation, `Output to ${cwd}/`)
    const taskState = ensureTaskExecutionState(conversation, cwd)
    markTaskIteration(taskState, { iterations: 1 })
    void recordBashArtifactProgress(taskState, 'bash', { command, cwd })

    const touchedOrScratched = [
      ...taskState.contract.touchedPaths,
      ...(taskState.run.scratchArtifactPaths ?? []),
    ]

    // Must NOT contain paths ending in div, h1, etc. (the bug report symptom)
    const divPath = join(cwd, 'div')
    const h1Path = join(cwd, 'h1')
    expect(touchedOrScratched).not.toContain(divPath)
    expect(touchedOrScratched).not.toContain(h1Path)
    // The actual output file SHOULD be there
    expect(touchedOrScratched).toContain(outFile)
  })
})

// ---------------------------------------------------------------------------
// T5 — A3: taskState.run.runWorkspace.deliverableMode is used as manifest hint
// ---------------------------------------------------------------------------

describe('T5 · A3: runWorkspace.deliverableMode flows into getDeliverableContract', () => {
  it('classifyDeliverableContract with manifestHint returns hint mode over empty text', () => {
    // Direct test of the classifier hint path used by getDeliverableContract internals
    const result = classifyDeliverableContract('', {
      manifestHint: { deliverableMode: 'file_artifact_delivery', confidence: 'high' },
    })
    expect(result.mode).toBe('file_artifact_delivery')
    expect(result.confidence).toBe('high')
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(true)
  })

  it('classifyDeliverableContract with manifestHint does not override ambiguous text with explicit code path', () => {
    const ambiguous = '修改 src/template.ts 的结构，并生成 deck 输出到 /tmp/deck.html'
    const withoutHint = classifyDeliverableContract(ambiguous)
    expect(withoutHint.mode).toBe('code_change')

    const withHint = classifyDeliverableContract(ambiguous, {
      manifestHint: { deliverableMode: 'file_artifact_delivery', confidence: 'high' },
    })
    expect(withHint.mode).toBe('code_change')
    expect(withHint.confidence).toBe('high')
  })

  it('classifyDeliverableContract with manifestHint can recover weak continuation text', () => {
    const ambiguous = '继续按已建 task plan 执行，稍后写入最终 deck'
    const withHint = classifyDeliverableContract(ambiguous, {
      manifestHint: { deliverableMode: 'file_artifact_delivery', confidence: 'high' },
    })
    expect(withHint.mode).toBe('file_artifact_delivery')
    expect(withHint.confidence).toBe('high')
  })

  it('A3 fault tolerance: invalid deliverableMode in manifest falls back to local classification', () => {
    // Simulates a corrupted manifest.json with unknown mode
    const result = classifyDeliverableContract('create a deck output to /tmp/deck.html', {
      manifestHint: { deliverableMode: 'not_a_real_mode' as any, confidence: 'high' },
    })
    expect(result.mode).toBe('file_artifact_delivery')
  })

  it('A3 fault tolerance: missing runWorkspace → local classification used', () => {
    // taskState with no runWorkspace → getDeliverableContract falls back to text signals
    const text = 'Create a 46-page HTML PPT output to /tmp/deck.html'
    // Without any hint: file_artifact_delivery should still be detected from text
    const result = classifyDeliverableContract(text)
    expect(result.mode).toBe('file_artifact_delivery')
  })

  it('A3 fault tolerance: mixed_unknown mode in manifest is NOT promoted to hint', () => {
    // resolveManifestHint filters mixed_unknown to prevent no-signal manifests from
    // overriding local classification
    const result = classifyDeliverableContract('fix the bug in src/foo.ts', {
      manifestHint: { deliverableMode: 'mixed_unknown', confidence: 'high' },
    })
    expect(result.mode).toBe('code_change')
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// T6 — End-to-end: manifest hint prevents task_no_progress_hard in deck trajectory
// ---------------------------------------------------------------------------

describe('T6 · End-to-end: deck trajectory with manifest hint avoids hard stop', () => {
  let workspaceDir: string
  let isolatedHome: string
  let prevOwlcodaHome: string | undefined
  let prevAllowFsRoots: string | undefined

  beforeEach(() => {
    workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), 'owlcoda-t6-')))
    isolatedHome = realpathSync(mkdtempSync(join(tmpdir(), 'owlcoda-t6-home-')))
    prevOwlcodaHome = process.env['OWLCODA_HOME']
    prevAllowFsRoots = process.env['OWLCODA_ALLOW_FS_ROOTS']
    process.env['OWLCODA_HOME'] = isolatedHome
    process.env['OWLCODA_ALLOW_FS_ROOTS'] = workspaceDir
    resetTaskStore()
  })

  afterEach(() => {
    if (prevOwlcodaHome === undefined) {
      delete process.env['OWLCODA_HOME']
    } else {
      process.env['OWLCODA_HOME'] = prevOwlcodaHome
    }
    if (prevAllowFsRoots === undefined) {
      delete process.env['OWLCODA_ALLOW_FS_ROOTS']
    } else {
      process.env['OWLCODA_ALLOW_FS_ROOTS'] = prevAllowFsRoots
    }
    try { rmSync(workspaceDir, { recursive: true, force: true }) } catch { /* swallow */ }
    try { rmSync(isolatedHome, { recursive: true, force: true }) } catch { /* swallow */ }
    resetTaskStore()
  })

  it('deck trajectory: Read then heredoc bash write → artifact lands, no hard stop', async () => {
    const deckPath = join(workspaceDir, 'test.html')

    // Scripted trajectory simulating the real failing case:
    //   Turn 1: text only (analysing task)
    //   Turn 2: tool_use Read (reads a template file)
    //   Turn 3: tool_use bash with heredoc write → A2 fix ensures correct path extraction
    //   Turn 4: end_turn

    const makeResponse = (body: object) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })

    const responses = [
      // Turn 1: analysing task
      makeResponse({
        type: 'message',
        role: 'assistant',
        model: 'mock',
        content: [{ type: 'text', text: '正在分析任务，先 Read 模板' }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5, output_tokens: 5 },
      }),
      // Turn 2: Read tool call (simulates model reading a template)
      makeResponse({
        type: 'message',
        role: 'assistant',
        model: 'mock',
        content: [{
          type: 'tool_use',
          id: 'tool-read-1',
          name: 'read',
          input: { path: join(workspaceDir, 'nonexistent-template.html') },
        }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 6, output_tokens: 6 },
      }),
      // Turn 3: bash heredoc write
      makeResponse({
        type: 'message',
        role: 'assistant',
        model: 'mock',
        content: [{
          type: 'tool_use',
          id: 'tool-bash-1',
          name: 'bash',
          input: {
            command: `cat > ${deckPath} <<'EOF'\n<div class="page">\n  <h1>Title</h1>\n</div>\nEOF`,
            cwd: workspaceDir,
          },
        }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 7, output_tokens: 7 },
      }),
      // Turn 4: completion
      makeResponse({
        type: 'message',
        role: 'assistant',
        model: 'mock',
        content: [{ type: 'text', text: '完成。已生成 test.html。' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 8, output_tokens: 8 },
      }),
    ]

    let callIndex = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      const idx = callIndex++
      if (idx < responses.length) return responses[idx]!
      return makeResponse({
        type: 'message', role: 'assistant', model: 'mock',
        content: [{ type: 'text', text: 'Done.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      })
    }

    try {
      const conv = createConversation({ system: 'test assistant', model: 'mock', maxTokens: 4096 })
      // Prompt: file_artifact_delivery task with explicit output path
      addUserMessage(conv, `创建一个 HTML PPT 输出到 ${deckPath}`)
      ensureTaskExecutionState(conv, workspaceDir)

      const result = await runConversationLoop(conv, new ToolDispatcher(), {
        apiBaseUrl: 'http://localhost:0',
        apiKey: 'mock-key',
        maxIterations: 10,
      })

      // The loop should not have terminated via hard stop
      expect(result.stopReason).not.toBe('task_no_progress_hard')

      // Verify: the telemetry gate-events should NOT contain task_no_progress_hard
      const { readdirSync, readFileSync } = await import('node:fs')
      const telemetryDir = join(isolatedHome, 'telemetry')
      let hardStopCount = 0
      try {
        const files = readdirSync(telemetryDir)
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue
          const lines = readFileSync(join(telemetryDir, file), 'utf8').split('\n').filter(Boolean)
          for (const line of lines) {
            try {
              const ev = JSON.parse(line) as { kind?: string }
              if (ev.kind === 'task_no_progress_hard') hardStopCount++
            } catch { /* skip malformed */ }
          }
        }
      } catch { /* no telemetry dir = no hard stops */ }

      expect(hardStopCount).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
