import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createReadTool } from '../../../src/native/tools/read.js'

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

  // ── Edge cases ──

  it('handles single line request', async () => {
    const result = await read.execute({
      path: join(dir, 'test.txt'),
      startLine: 1,
      endLine: 1,
    })
    expect(result.isError).toBe(false)
    expect(result.output).toBe('1\tLine 1')
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
})
