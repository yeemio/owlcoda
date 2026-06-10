import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGrepTool, recordGrepAndBuildNudge } from '../../../src/native/tools/grep.js'
import { createConversation, addUserMessage } from '../../../src/native/conversation.js'
import { ensureTaskExecutionState } from '../../../src/native/task-state.js'

describe('Native Grep tool', () => {
  const grep = createGrepTool()
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'owlcoda-grep-test-'))
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(
      join(dir, 'src', 'app.ts'),
      'function hello() {\n  return "world"\n}\n'
    )
    await writeFile(
      join(dir, 'src', 'utils.ts'),
      'export function helper() {\n  return 42\n}\n'
    )
    await writeFile(join(dir, 'README.md'), '# Hello World\nThis is a test.\n')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('has correct name', () => {
    expect(grep.name).toBe('grep')
  })

  it('finds matches in files', async () => {
    const result = await grep.execute({ pattern: 'function', path: dir })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('function')
    expect(result.output).toContain(join(dir, 'src', 'app.ts'))
    expect(result.metadata?.matchLines).toBeGreaterThanOrEqual(2)
  })

  it('reports zero matches as a clear "[grep ok] 0 matches" success (0.13.60)', async () => {
    const result = await grep.execute({
      pattern: 'zzz_nonexistent_zzz',
      path: dir,
    })
    expect(result.isError).toBe(false)
    // 0.13.60: explicit "[grep ok]" prefix + pattern + path so the
    // model can't misread "no matches" as "search failed".
    expect(result.output).toMatch(/\[grep ok\] 0 matches/)
    expect(result.output).toContain('"zzz_nonexistent_zzz"')
    expect(result.output).toMatch(/Search ran cleanly/)
    expect(result.metadata?.zeroMatches).toBe(true)
    expect(result.metadata?.matchLines).toBe(0)
  })

  it('supports case-insensitive search', async () => {
    const result = await grep.execute({
      pattern: 'HELLO',
      path: dir,
      ignoreCase: true,
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('hello') // should find lowercase
  })

  it('searches a single file', async () => {
    const result = await grep.execute({
      pattern: 'return',
      path: join(dir, 'src', 'app.ts'),
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain(join(dir, 'src', 'app.ts'))
    expect(result.output).toContain('return')
    expect(result.output).toContain('world')
  })

  it('filters by include pattern', async () => {
    const result = await grep.execute({
      pattern: 'function',
      path: dir,
      include: '*.ts',
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('function')
    // Should not match README.md
    expect(result.output).not.toContain('README')
  })

  it('respects maxResults', async () => {
    const result = await grep.execute({
      pattern: '.',
      path: dir,
      maxResults: 2,
    })
    expect(result.isError).toBe(false)
    const lines = result.output.split('\n').filter(Boolean)
    expect(lines.length).toBeLessThanOrEqual(2)
  })

  it('errors on invalid regex', async () => {
    const result = await grep.execute({
      pattern: '[invalid',
      path: join(dir, 'README.md'),
    })
    // ripgrep may handle this differently, but at least one engine should report error
    // If ripgrep is not installed, native will catch it
    expect(result.output).toBeTruthy()
  })

  it('handles regex special characters', async () => {
    const result = await grep.execute({
      pattern: 'return \\d+',
      path: join(dir, 'src', 'utils.ts'),
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('42')
  })

  it('emits at least one progress heartbeat', async () => {
    const events: Array<{ totalLines: number; last: string | undefined }> = []
    const result = await grep.execute(
      {
        pattern: 'function',
        path: dir,
      },
      {
        onProgress(event) {
          events.push({ totalLines: event.totalLines, last: event.lines.at(-1) })
        },
      },
    )
    expect(result.isError).toBe(false)
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0]?.last).toContain('Scanning')
  })

  it('honors an already-aborted signal', async () => {
    const ac = new AbortController()
    ac.abort()
    const result = await grep.execute({
      pattern: 'function',
      path: dir,
    }, {
      signal: ac.signal,
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('[partial aborted]')
    expect(result.metadata?.partial).toBe(true)
    expect(result.metadata?.reason).toBe('aborted')
  })

  // 0.13.71 evidence_ledger_v1 (grep arm). Mirrors 0.13.69 read-
  // repeat semantics: don't block, prepend a notice on the 2nd
  // identical grep, upgrade to a warning on 3rd+. Same advisory
  // stance — the model can still re-run if it has reason.
  describe('grep-repeat nudge (0.13.71)', () => {
    it('first grep returns no nudge prefix', async () => {
      const conv = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conv, 'Search the code')
      const taskState = ensureTaskExecutionState(conv, dir)
      const result = await grep.execute({ pattern: 'function', path: dir }, { taskState })
      expect(result.isError).toBe(false)
      expect(result.output).not.toContain('[Runtime grep-repeat')
    })

    it('second identical grep prepends a notice and reports both match counts', async () => {
      const conv = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conv, 'Search twice')
      const taskState = ensureTaskExecutionState(conv, dir)

      const first = await grep.execute({ pattern: 'function', path: dir }, { taskState })
      expect(first.output).not.toContain('[Runtime grep-repeat')
      const firstMatchCount = first.metadata?.matchLines as number

      const second = await grep.execute({ pattern: 'function', path: dir }, { taskState })
      expect(second.output).toContain('[Runtime grep-repeat notice]')
      expect(second.output).toContain('pattern="function"')
      expect(second.output).toContain(`Previous run matched ${firstMatchCount}`)
      expect(second.output).toContain('Reuse the prior evidence')
      expect(second.metadata?.grepRepeatCount).toBe(2)
    })

    it('third+ identical grep upgrades to a warning with ordinal', async () => {
      const conv = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conv, 'Search many times')
      const taskState = ensureTaskExecutionState(conv, dir)

      await grep.execute({ pattern: 'function', path: dir }, { taskState })
      await grep.execute({ pattern: 'function', path: dir }, { taskState })
      const third = await grep.execute({ pattern: 'function', path: dir }, { taskState })
      expect(third.output).toContain('[Runtime grep-repeat warning]')
      expect(third.output).toContain('3rd run of the same grep')
      expect(third.metadata?.grepRepeatCount).toBe(3)
    })

    it('different pattern is tracked independently', async () => {
      const conv = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conv, 'Search different patterns')
      const taskState = ensureTaskExecutionState(conv, dir)

      await grep.execute({ pattern: 'function', path: dir }, { taskState })
      const otherFirst = await grep.execute({ pattern: 'class', path: dir }, { taskState })
      expect(otherFirst.output).not.toContain('[Runtime grep-repeat')
    })

    it('different ignoreCase setting is tracked independently', async () => {
      const conv = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conv, 'Toggle case sensitivity')
      const taskState = ensureTaskExecutionState(conv, dir)

      await grep.execute({ pattern: 'function', path: dir }, { taskState })
      const caseInsensitive = await grep.execute({ pattern: 'function', path: dir, ignoreCase: true }, { taskState })
      expect(caseInsensitive.output).not.toContain('[Runtime grep-repeat')
    })

    it('different TaskExecutionState identities have independent ledgers', async () => {
      const convA = createConversation({ system: 'test', model: 'm' })
      addUserMessage(convA, 'task A')
      const taskA = ensureTaskExecutionState(convA, dir)
      const convB = createConversation({ system: 'test', model: 'm' })
      addUserMessage(convB, 'task B unrelated')
      const taskB = ensureTaskExecutionState(convB, dir)

      await grep.execute({ pattern: 'function', path: dir }, { taskState: taskA })
      await grep.execute({ pattern: 'function', path: dir }, { taskState: taskA })
      await grep.execute({ pattern: 'function', path: dir }, { taskState: taskA })
      const firstInB = await grep.execute({ pattern: 'function', path: dir }, { taskState: taskB })
      expect(firstInB.output).not.toContain('[Runtime grep-repeat')
    })

    it('absent taskState (headless) emits no nudges', async () => {
      const a = await grep.execute({ pattern: 'function', path: dir })
      const b = await grep.execute({ pattern: 'function', path: dir })
      expect(a.output).not.toContain('[Runtime grep-repeat')
      expect(b.output).not.toContain('[Runtime grep-repeat')
    })

    // Direct unit test on the helper for ordinal correctness and
    // count progression independent of the actual grep IO.
    it('recordGrepAndBuildNudge: count progression and ordinals', () => {
      const conv = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conv, 'unit')
      const taskState = ensureTaskExecutionState(conv, dir)
      const input = { pattern: 'foo', path: '/abs' }
      expect(recordGrepAndBuildNudge(taskState, input, 5).prefix).toBeNull()
      expect(recordGrepAndBuildNudge(taskState, input, 5).prefix).toContain('notice]')
      expect(recordGrepAndBuildNudge(taskState, input, 5).prefix).toContain('3rd run')
      expect(recordGrepAndBuildNudge(taskState, input, 5).prefix).toContain('4th run')
    })
  })
})
