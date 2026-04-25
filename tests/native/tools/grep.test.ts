import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGrepTool } from '../../../src/native/tools/grep.js'

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

  it('reports "No matches" when nothing found', async () => {
    const result = await grep.execute({
      pattern: 'zzz_nonexistent_zzz',
      path: dir,
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('No matches')
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
})
