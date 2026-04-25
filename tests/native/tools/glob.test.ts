import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGlobTool } from '../../../src/native/tools/glob.js'

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
})
