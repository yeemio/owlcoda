import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, realpath, writeFile, rm, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createReadTool, recordReadAndBuildNudge } from '../../../src/native/tools/read.js'
import { createConversation, addUserMessage } from '../../../src/native/conversation.js'
import { ensureTaskExecutionState } from '../../../src/native/task-state.js'

describe('Native Read tool', () => {
  const read = createReadTool()
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'owlcoda-read-test-'))
    // Create a test file with known content
    const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`)
    await writeFile(join(dir, 'test.txt'), lines.join('\n'))
    // Empty file
    await writeFile(join(dir, 'empty.txt'), '')
    // Binary-ish content
    await writeFile(join(dir, 'data.bin'), Buffer.alloc(100, 0xff))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  // ── Basic contract ──

  it('has correct name', () => {
    expect(read.name).toBe('read')
  })

  // ── Full file read ──

  it('reads entire file with line numbers', async () => {
    const result = await read.execute({ path: join(dir, 'test.txt') })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('1\tLine 1')
    expect(result.output).toContain('20\tLine 20')
    expect(result.metadata?.totalLines).toBe(20)
  })

  it('reads empty file', async () => {
    const result = await read.execute({ path: join(dir, 'empty.txt') })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('1\t')
  })

  // ── Line range ──

  it('reads specific line range', async () => {
    const result = await read.execute({
      path: join(dir, 'test.txt'),
      startLine: 5,
      endLine: 7,
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('5\tLine 5')
    expect(result.output).toContain('7\tLine 7')
    expect(result.output).not.toContain('4\t')
    expect(result.output).not.toContain('8\t')
  })

  it('clamps endLine to file length', async () => {
    const result = await read.execute({
      path: join(dir, 'test.txt'),
      startLine: 18,
      endLine: 999,
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('18\tLine 18')
    expect(result.output).toContain('20\tLine 20')
  })

  it('errors when startLine exceeds file length', async () => {
    const result = await read.execute({
      path: join(dir, 'test.txt'),
      startLine: 100,
    })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('exceeds file length')
  })

  // ── Byte range ──

  it('reads byte range with offset and limit', async () => {
    const result = await read.execute({
      path: join(dir, 'test.txt'),
      offset: 0,
      limit: 10,
    })
    expect(result.isError).toBe(false)
    expect(result.metadata?.bytesRead).toBeLessThanOrEqual(10)
  })

  it('reads from offset', async () => {
    // "Line 1\nLine 2\n..." — offset past first line
    const result = await read.execute({
      path: join(dir, 'test.txt'),
      offset: 7, // skip "Line 1\n"
      limit: 6,
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Line 2')
  })

  // ── Error cases ──

  it('errors on non-existent file', async () => {
    const result = await read.execute({ path: join(dir, 'nope.txt') })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Error')
  })

  it('errors on directory', async () => {
    const result = await read.execute({ path: dir })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('directory')
  })

  it('refuses sensitive system paths via fs-policy before opening the file', async () => {
    const result = await read.execute({ path: '/etc/shadow' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Refusing to read')
    expect(result.metadata?.fsPolicyDenied).toBe(true)
  })

  // ── Edge cases ──

  it('handles single line request', async () => {
    const result = await read.execute({
      path: join(dir, 'test.txt'),
      startLine: 1,
      endLine: 1,
    })
    expect(result.isError).toBe(false)
    // 0.13.60: read output now starts with `[file: <abs-path>]` header
    expect(result.output).toMatch(/^\[file: .*test\.txt\]\n1\tLine 1$/)
  })

  it('reads binary content without crashing', async () => {
    const result = await read.execute({ path: join(dir, 'data.bin') })
    expect(result.isError).toBe(false)
  })

  it('accepts grep-style path:line input', async () => {
    const result = await read.execute({ path: `${join(dir, 'test.txt')}:5` })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('5\tLine 5')
  })

  it('recovers a uniquely matched truncated filename prefix', async () => {
    await writeFile(join(dir, 'runtime-round-1-docker-playwright-baseline.md'), 'Prompt body')
    const result = await read.execute({ path: join(dir, 'runtime-round-1-') })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('1\tPrompt body')
  })

  it('honors an already-aborted signal', async () => {
    const ac = new AbortController()
    ac.abort()
    const result = await read.execute({ path: join(dir, 'test.txt') }, { signal: ac.signal })
    expect(result.isError).toBe(true)
    expect(result.metadata?.aborted).toBe(true)
  })

  // 0.13.59 line-ending annotation. CRLF and mixed get a bracketed
  // header so the model knows; LF (the common case) stays silent.
  describe('line-ending annotation (0.13.59)', () => {
    it('CRLF file gets file-path header AND CRLF header at the top', async () => {
      const path = join(dir, 'crlf-read.txt')
      await writeFile(path, 'first\r\nsecond\r\nthird\r\n')
      const real = await realpath(path)
      const result = await read.execute({ path })
      expect(result.isError).toBe(false)
      // 0.13.60: file-path header is line 1 (using realpath since fs-policy normalizes symlinks)
      expect(result.output.startsWith(`[file: ${real}]`)).toBe(true)
      expect(result.output).toMatch(/file uses CRLF line endings/)
      expect(result.output).toMatch(/copy oldStr exactly when editing/)
      expect(result.metadata?.lineEndingKind).toBe('CRLF')
      expect(result.metadata?.path).toBe(real)
    })

    it('mixed-ending file gets a MIXED header', async () => {
      const path = join(dir, 'mixed-read.txt')
      await writeFile(path, 'a\r\nb\nc\r\n')
      const real = await realpath(path)
      const result = await read.execute({ path })
      expect(result.isError).toBe(false)
      expect(result.output.startsWith(`[file: ${real}]`)).toBe(true)
      expect(result.output).toMatch(/file has MIXED line endings/)
      expect(result.metadata?.lineEndingKind).toBe('mixed')
    })

    it('LF file gets ONLY the file-path header (no line-ending warning)', async () => {
      const path = join(dir, 'lf-read.txt')
      await writeFile(path, 'first\nsecond\nthird\n')
      const real = await realpath(path)
      const result = await read.execute({ path })
      expect(result.isError).toBe(false)
      expect(result.output.startsWith(`[file: ${real}]`)).toBe(true)
      expect(result.output).not.toMatch(/CRLF/)
      expect(result.output).not.toMatch(/MIXED/)
      expect(result.output).toContain('1\tfirst')
      expect(result.metadata?.lineEndingKind).toBe('LF')
    })

    it('header still appears when reading a line range from CRLF file', async () => {
      const path = join(dir, 'crlf-range.txt')
      await writeFile(path, 'a\r\nb\r\nc\r\nd\r\ne\r\n')
      const real = await realpath(path)
      const result = await read.execute({ path, startLine: 2, endLine: 4 })
      expect(result.isError).toBe(false)
      expect(result.output.startsWith(`[file: ${real}]`)).toBe(true)
      expect(result.output).toMatch(/file uses CRLF line endings/)
      expect(result.output).toContain('2\tb')
      expect(result.output).toContain('4\td')
    })
  })

  // 0.13.60: file-path header is always present so model can
  // associate this read's content with its source. Long-context
  // sessions reading 5+ files in parallel used to produce
  // indistinguishable `1\tline\n…` outputs.
  describe('file-path header (0.13.60)', () => {
    it('every read starts with [file: <abs-path>] header', async () => {
      const path = join(dir, 'header-test.txt')
      await writeFile(path, 'one\ntwo\n')
      const real = await realpath(path)
      const result = await read.execute({ path })
      expect(result.output.startsWith(`[file: ${real}]`)).toBe(true)
    })

    it('byte-range read also includes the path header (with byte-range tag)', async () => {
      const path = join(dir, 'byte-range.txt')
      await writeFile(path, 'abcdefghij')
      const real = await realpath(path)
      const result = await read.execute({ path, offset: 3, limit: 4 })
      expect(result.isError).toBe(false)
      expect(result.output.startsWith(`[file: ${real}] [byte range:`)).toBe(true)
      expect(result.output).toContain('defg')
    })
  })

  // 0.13.69: read_repetition_nudge_v1. The 2026-05-07
  // deepseek/kimi engineering-contract dogfood read
  // mionyee-mobile/src/services/api.ts 7+ times within one task with
  // no mutation between reads — burning ~120s/iteration. The nudge
  // doesn't block the read, doesn't substitute cached content, and
  // doesn't change success/failure semantics. It prepends a runtime
  // notice on the 2nd repeat read of the same (path, range) on an
  // unchanged file, and a stronger warning on the 3rd+. File
  // mutation (mtime/size change) resets the counter.
  describe('read-repeat nudge (0.13.69)', () => {
    it('first read of a path returns no nudge prefix', async () => {
      const path = join(dir, 'nudge-first.txt')
      await writeFile(path, 'one\ntwo\nthree\n')
      const conv = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conv, 'Read it')
      const taskState = ensureTaskExecutionState(conv, dir)

      const result = await read.execute({ path }, { taskState })
      expect(result.isError).toBe(false)
      expect(result.output).not.toContain('[Runtime read-repeat')
    })

    it('second read of the same unchanged file prepends a notice', async () => {
      const path = join(dir, 'nudge-second.txt')
      await writeFile(path, 'one\ntwo\nthree\n')
      const conv = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conv, 'Read it twice')
      const taskState = ensureTaskExecutionState(conv, dir)
      const real = await realpath(path)

      const first = await read.execute({ path }, { taskState })
      expect(first.output).not.toContain('[Runtime read-repeat')

      const second = await read.execute({ path }, { taskState })
      expect(second.isError).toBe(false)
      expect(second.output).toContain('[Runtime read-repeat notice]')
      expect(second.output).toContain(`You already read this file earlier in this task: ${real}`)
      expect(second.output).toContain('same mtime, same size, same range')
      expect(second.output).toContain('stop reading and produce the draft/write tool')
      // Body still contains the actual file content — read is not blocked.
      expect(second.output).toContain('1\tone')
      expect(second.metadata?.readRepeatCount).toBe(2)
    })

    it('third+ read upgrades to a warning with the correct ordinal', async () => {
      const path = join(dir, 'nudge-third.txt')
      await writeFile(path, 'a\nb\n')
      const conv = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conv, 'Read it many times')
      const taskState = ensureTaskExecutionState(conv, dir)

      await read.execute({ path }, { taskState })
      await read.execute({ path }, { taskState }) // 2nd → notice
      const third = await read.execute({ path }, { taskState })
      expect(third.output).toContain('[Runtime read-repeat warning]')
      expect(third.output).toContain('This is the 3rd read of the same unchanged file')
      expect(third.output).toContain('narrow to a line range, grep a specific symbol, or write the deliverable')
      expect(third.metadata?.readRepeatCount).toBe(3)

      const fourth = await read.execute({ path }, { taskState })
      expect(fourth.output).toContain('This is the 4th read')
      expect(fourth.metadata?.readRepeatCount).toBe(4)
    })

    it('file mutation (mtime/size change) resets the counter — no nudge after edit', async () => {
      const path = join(dir, 'nudge-mutation.txt')
      await writeFile(path, 'before\n')
      const conv = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conv, 'Read, edit, read')
      const taskState = ensureTaskExecutionState(conv, dir)

      await read.execute({ path }, { taskState })
      const second = await read.execute({ path }, { taskState })
      expect(second.output).toContain('[Runtime read-repeat notice]')

      // Mutate the file and force a different mtime AND size.
      await writeFile(path, 'before\nafter\n')
      const futureMtime = new Date(Date.now() + 5_000)
      await utimes(path, futureMtime, futureMtime)

      const third = await read.execute({ path }, { taskState })
      expect(third.isError).toBe(false)
      // Counter reset because file changed: should NOT be a notice/warning.
      expect(third.output).not.toContain('[Runtime read-repeat')
    })

    it('different ranges of the same file are tracked independently', async () => {
      const path = join(dir, 'nudge-ranges.txt')
      await writeFile(path, Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`).join('\n'))
      const conv = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conv, 'Read different ranges')
      const taskState = ensureTaskExecutionState(conv, dir)

      // First reads of two distinct ranges — each is its own first read.
      const a1 = await read.execute({ path, startLine: 1, endLine: 10 }, { taskState })
      const b1 = await read.execute({ path, startLine: 11, endLine: 20 }, { taskState })
      expect(a1.output).not.toContain('[Runtime read-repeat')
      expect(b1.output).not.toContain('[Runtime read-repeat')

      // Repeat of range A → notice.
      const a2 = await read.execute({ path, startLine: 1, endLine: 10 }, { taskState })
      expect(a2.output).toContain('[Runtime read-repeat notice]')
      // Range B still not repeated → silent.
      const b2 = await read.execute({ path, startLine: 21, endLine: 30 }, { taskState })
      expect(b2.output).not.toContain('[Runtime read-repeat')
    })

    it('different TaskExecutionState identities have independent ledgers', async () => {
      const path = join(dir, 'nudge-isolation.txt')
      await writeFile(path, 'x\n')
      const convA = createConversation({ system: 'test', model: 'm' })
      addUserMessage(convA, 'task A')
      const taskA = ensureTaskExecutionState(convA, dir)

      const convB = createConversation({ system: 'test', model: 'm' })
      addUserMessage(convB, 'task B — entirely separate session')
      const taskB = ensureTaskExecutionState(convB, dir)

      // Three reads in task A, then one read in task B.
      await read.execute({ path }, { taskState: taskA })
      await read.execute({ path }, { taskState: taskA })
      await read.execute({ path }, { taskState: taskA })
      const firstInB = await read.execute({ path }, { taskState: taskB })
      // Task B's ledger is empty — first read is silent even though A
      // has accumulated 3 reads of the same path.
      expect(firstInB.output).not.toContain('[Runtime read-repeat')
    })

    it('absent taskState (headless / pre-task contract) emits no nudges', async () => {
      const path = join(dir, 'nudge-no-task.txt')
      await writeFile(path, 'no task state here\n')
      // No taskState in context — should never throw, never prefix.
      const a = await read.execute({ path })
      const b = await read.execute({ path })
      expect(a.output).not.toContain('[Runtime read-repeat')
      expect(b.output).not.toContain('[Runtime read-repeat')
    })

    it('byte-range reads also pick up the nudge', async () => {
      const path = join(dir, 'nudge-byte-range.txt')
      await writeFile(path, 'abcdefghij')
      const conv = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conv, 'Read byte range twice')
      const taskState = ensureTaskExecutionState(conv, dir)

      await read.execute({ path, offset: 0, limit: 5 }, { taskState })
      const second = await read.execute({ path, offset: 0, limit: 5 }, { taskState })
      expect(second.output).toContain('[Runtime read-repeat notice]')
      expect(second.output).toContain('abcde')
    })

    // Direct unit test on the helper, bypassing fs IO. Locks down
    // the count progression and ordinal formatting irrespective of
    // disk state.
    it('recordReadAndBuildNudge: count progression and ordinals', () => {
      const conv = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conv, 'unit test')
      const taskState = ensureTaskExecutionState(conv, dir)
      const realpath = '/abs/file.ts'
      const rangeKey = 'full'
      const mtime = 1000
      const size = 42

      expect(recordReadAndBuildNudge(taskState, realpath, rangeKey, mtime, size).prefix).toBeNull()
      expect(recordReadAndBuildNudge(taskState, realpath, rangeKey, mtime, size).prefix).toContain('notice]')
      expect(recordReadAndBuildNudge(taskState, realpath, rangeKey, mtime, size).prefix).toContain('3rd read')
      expect(recordReadAndBuildNudge(taskState, realpath, rangeKey, mtime, size).prefix).toContain('4th read')

      // Mutation resets the counter.
      const after = recordReadAndBuildNudge(taskState, realpath, rangeKey, mtime + 1, size)
      expect(after.prefix).toBeNull()
      expect(after.count).toBe(1)
    })
  })
})
