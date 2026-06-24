import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGlobTool, recordGlobAndBuildNudge } from '../../../src/native/tools/glob.js'
import { createConversation, addUserMessage } from '../../../src/native/conversation.js'
import { ensureTaskExecutionState } from '../../../src/native/task-state.js'

describe('Native Glob tool', () => {
  const glob = createGlobTool()
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'owlcoda-glob-test-'))
    // Create test structure
    await mkdir(join(dir, 'src'), { recursive: true })
    await mkdir(join(dir, 'src', 'utils'), { recursive: true })
    await mkdir(join(dir, 'docs'), { recursive: true })
    await writeFile(join(dir, 'src', 'index.ts'), '')
    await writeFile(join(dir, 'src', 'utils', 'helper.ts'), '')
    await writeFile(join(dir, 'src', 'main.js'), '')
    await writeFile(join(dir, 'docs', 'README.md'), '')
    await writeFile(join(dir, 'package.json'), '')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('has correct name', () => {
    expect(glob.name).toBe('glob')
  })

  it('matches *.ts files recursively with **', async () => {
    const result = await glob.execute({ pattern: '**/*.ts', cwd: dir })
    expect(result.isError).toBe(false)
    expect(result.output).toContain(join(dir, 'src', 'index.ts'))
    expect(result.output).toContain(join(dir, 'src', 'utils', 'helper.ts'))
    expect(result.output).not.toContain('main.js')
  })

  it('matches files in specific directory', async () => {
    const result = await glob.execute({ pattern: 'src/*.ts', cwd: dir })
    expect(result.isError).toBe(false)
    expect(result.output).toContain(join(dir, 'src', 'index.ts'))
    expect(result.output).not.toContain(join(dir, 'src', 'utils', 'helper.ts')) // in subdirectory
  })

  it('matches with brace expansion', async () => {
    const result = await glob.execute({ pattern: '**/*.{ts,js}', cwd: dir })
    expect(result.isError).toBe(false)
    expect(result.output).toContain(join(dir, 'src', 'index.ts'))
    expect(result.output).toContain(join(dir, 'src', 'main.js'))
    expect(result.output).not.toContain('README.md')
  })

  it('returns "No files matched" for no matches', async () => {
    const result = await glob.execute({ pattern: '**/*.xyz', cwd: dir })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('No files matched')
    expect(result.metadata?.count).toBe(0)
  })

  it('reports count in metadata', async () => {
    const result = await glob.execute({ pattern: '**/*', cwd: dir })
    expect(result.isError).toBe(false)
    expect(result.metadata?.count).toBeGreaterThanOrEqual(5)
  })

  it('respects ignore patterns', async () => {
    // Create a node_modules dir that should be ignored by default
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'dep.ts'), '')
    const result = await glob.execute({ pattern: '**/*.ts', cwd: dir })
    expect(result.isError).toBe(false)
    expect(result.output).not.toContain('dep.ts')
  })

  it('emits at least one progress heartbeat', async () => {
    const events: Array<{ totalLines: number; last: string | undefined }> = []
    const result = await glob.execute(
      { pattern: '**/*.ts', cwd: dir },
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
    const result = await glob.execute({ pattern: '**/*.ts', cwd: dir }, { signal: ac.signal })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('[partial aborted]')
    expect(result.metadata?.partial).toBe(true)
    expect(result.metadata?.reason).toBe('aborted')
  })

  it('marks small result sets as not truncated', async () => {
    const result = await glob.execute({ pattern: '**/*.ts', cwd: dir })
    expect(result.isError).toBe(false)
    expect(result.metadata?.truncated).toBe(false)
    expect(result.metadata?.totalCount).toBeUndefined()
    expect(result.output).not.toContain('truncated:')
  })

  // 0.13.71 evidence_ledger_v1 (glob arm). Same advisory-only
  // semantics as the read and grep arms.
  describe('glob-repeat nudge (0.13.71)', () => {
    it('first glob returns no nudge prefix', async () => {
      const conv = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conv, 'List ts files')
      const taskState = ensureTaskExecutionState(conv, dir)
      const result = await glob.execute({ pattern: '**/*.ts', cwd: dir }, { taskState })
      expect(result.isError).toBe(false)
      expect(result.output).not.toContain('[Runtime glob-repeat')
    })

    it('second identical glob prepends a notice', async () => {
      const conv = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conv, 'List twice')
      const taskState = ensureTaskExecutionState(conv, dir)
      const first = await glob.execute({ pattern: '**/*.ts', cwd: dir }, { taskState })
      expect(first.output).not.toContain('[Runtime glob-repeat')
      const second = await glob.execute({ pattern: '**/*.ts', cwd: dir }, { taskState })
      expect(second.output).toContain('[Runtime glob-repeat notice]')
      expect(second.output).toContain('pattern="**/*.ts"')
      expect(second.output).toContain('Reuse the prior file list')
      expect(second.metadata?.globRepeatCount).toBe(2)
    })

    it('third+ identical glob upgrades to a warning with ordinal', async () => {
      const conv = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conv, 'List many times')
      const taskState = ensureTaskExecutionState(conv, dir)
      await glob.execute({ pattern: '**/*.ts', cwd: dir }, { taskState })
      await glob.execute({ pattern: '**/*.ts', cwd: dir }, { taskState })
      const third = await glob.execute({ pattern: '**/*.ts', cwd: dir }, { taskState })
      expect(third.output).toContain('[Runtime glob-repeat warning]')
      expect(third.output).toContain('3rd run of the same glob')
      expect(third.metadata?.globRepeatCount).toBe(3)
    })

    it('different pattern is tracked independently', async () => {
      const conv = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conv, 'Different patterns')
      const taskState = ensureTaskExecutionState(conv, dir)
      await glob.execute({ pattern: '**/*.ts', cwd: dir }, { taskState })
      const otherFirst = await glob.execute({ pattern: '**/*.js', cwd: dir }, { taskState })
      expect(otherFirst.output).not.toContain('[Runtime glob-repeat')
    })

    it('absent taskState (headless) emits no nudges', async () => {
      const a = await glob.execute({ pattern: '**/*.ts', cwd: dir })
      const b = await glob.execute({ pattern: '**/*.ts', cwd: dir })
      expect(a.output).not.toContain('[Runtime glob-repeat')
      expect(b.output).not.toContain('[Runtime glob-repeat')
    })

    it('recordGlobAndBuildNudge: count progression', () => {
      const conv = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conv, 'unit')
      const taskState = ensureTaskExecutionState(conv, dir)
      const input = { pattern: '*.ts', cwd: '/abs' }
      expect(recordGlobAndBuildNudge(taskState, input, 12).prefix).toBeNull()
      expect(recordGlobAndBuildNudge(taskState, input, 12).prefix).toContain('notice]')
      expect(recordGlobAndBuildNudge(taskState, input, 12).prefix).toContain('3rd run')
    })
  })
})

// OC-20260623-15 — regression: out/** must NOT be blanket-ignored.
describe('Native Glob tool — out directory (OC-20260623-15)', () => {
  const glob = createGlobTool()
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'owlcoda-glob-out-'))
    // Reproduce the Round 55 workspace layout.
    await mkdir(join(dir, 'out', 'full'), { recursive: true })
    await mkdir(join(dir, 'out', 'dataset_repair_20260618'), { recursive: true })
    await writeFile(join(dir, 'out', 'full', 'L0_qa.jsonl'), 'data')
    await writeFile(join(dir, 'out', 'full', 'L1_qa.jsonl'), 'data')
    await writeFile(join(dir, 'out', 'full', 'L2_qa.jsonl'), 'data')
    await writeFile(join(dir, 'out', 'full', 'L3_qa.jsonl'), 'data')
    await writeFile(join(dir, 'out', 'full', 'L0_identity_qa_merged_20260618.jsonl'), 'data')
    await writeFile(join(dir, 'out', 'full', 'L2_compare_qa.jsonl'), 'data')
    await writeFile(join(dir, 'out', 'dataset_repair_20260618', 'STATS.md'), 'data')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('finds files under out/** (broad double-star)', async () => {
    const result = await glob.execute({ pattern: 'out/**', cwd: dir })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('L0_qa.jsonl')
    expect(result.output).toContain('STATS.md')
    expect(result.metadata?.count).toBeGreaterThanOrEqual(7)
  })

  it('finds files under out/full/*.jsonl', async () => {
    const result = await glob.execute({ pattern: 'out/full/*.jsonl', cwd: dir })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('L0_qa.jsonl')
    expect(result.output).toContain('L1_qa.jsonl')
    expect(result.output).toContain('L2_qa.jsonl')
    expect(result.output).toContain('L3_qa.jsonl')
    expect(result.output).toContain('L0_identity_qa_merged_20260618.jsonl')
    expect(result.output).toContain('L2_compare_qa.jsonl')
    expect(result.metadata?.count).toBe(6)
  })

  it('finds files under out/dataset_repair_20260618/**/*', async () => {
    const result = await glob.execute({ pattern: 'out/dataset_repair_20260618/**/*', cwd: dir })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('STATS.md')
    expect(result.metadata?.count).toBeGreaterThanOrEqual(1)
  })

  // Negative: truly-excluded directories must remain excluded.
  it('still ignores node_modules', async () => {
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'pkg', 'index.ts'), '')
    const result = await glob.execute({ pattern: '**/*.ts', cwd: dir })
    expect(result.isError).toBe(false)
    expect(result.output).not.toContain('node_modules')
  })

  it('still ignores dist', async () => {
    await mkdir(join(dir, 'dist'), { recursive: true })
    await writeFile(join(dir, 'dist', 'bundle.js'), '')
    const result = await glob.execute({ pattern: '**/*.js', cwd: dir })
    expect(result.isError).toBe(false)
    expect(result.output).not.toContain('dist')
  })

  it('still ignores .git', async () => {
    await mkdir(join(dir, '.git', 'objects'), { recursive: true })
    await writeFile(join(dir, '.git', 'objects', 'pack.bin'), '')
    const result = await glob.execute({ pattern: '**/*', cwd: dir })
    expect(result.isError).toBe(false)
    expect(result.output).not.toContain('.git')
  })
})

describe('Native Glob tool — truncation signaling', () => {
  const glob = createGlobTool()
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'owlcoda-glob-trunc-'))
    // Generate >MAX_RESULTS (10_000) files in a flat directory to exercise the
    // display-truncation path. We stay under HARD_RESULT_CAP (20_000) so the
    // collection itself completes naturally.
    const files: Promise<unknown>[] = []
    for (let i = 0; i < 10_500; i++) {
      files.push(writeFile(join(dir, `f${i}.ts`), ''))
    }
    await Promise.all(files)
  }, 60_000)

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('emits sentinel + metadata when display is truncated', async () => {
    const result = await glob.execute({ pattern: '**/*.ts', cwd: dir })
    expect(result.isError).toBe(false)
    // Sentinel line at end of output.
    expect(result.output).toMatch(/\.\.\. \(truncated: 10500 total, showing first 10000\)$/)
    // Metadata.
    expect(result.metadata?.truncated).toBe(true)
    expect(result.metadata?.totalCount).toBe(10_500)
    expect(result.metadata?.returnedCount).toBe(10_000)
    expect(result.metadata?.count).toBe(10_000)
    // Truncation is partial success, not error.
    expect(result.metadata?.partial).toBeUndefined()
  }, 60_000)
})
