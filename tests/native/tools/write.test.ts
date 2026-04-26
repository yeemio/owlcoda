import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWriteTool } from '../../../src/native/tools/write.js'

describe('Native Write tool', () => {
  const write = createWriteTool()
  let dir: string
  let prevAllow: string | undefined

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'owlcoda-write-test-'))
    // The fs-policy guard restricts writes to process.cwd() by default.
    // Test fixtures live under tmpdir(), so opt that path in via the same
    // env-var seam real users would use to extend scope.
    prevAllow = process.env['OWLCODA_ALLOW_FS_ROOTS']
    process.env['OWLCODA_ALLOW_FS_ROOTS'] = dir
  })

  afterAll(async () => {
    if (prevAllow === undefined) delete process.env['OWLCODA_ALLOW_FS_ROOTS']
    else process.env['OWLCODA_ALLOW_FS_ROOTS'] = prevAllow
    await rm(dir, { recursive: true, force: true })
  })

  it('has correct name', () => {
    expect(write.name).toBe('write')
  })

  it('writes a new file', async () => {
    const path = join(dir, 'new.txt')
    const result = await write.execute({ path, content: 'hello world' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('bytes')
    const content = await readFile(path, 'utf-8')
    expect(content).toBe('hello world')
  })

  it('overwrites existing file atomically', async () => {
    const path = join(dir, 'overwrite.txt')
    await writeFile(path, 'old content')
    const result = await write.execute({ path, content: 'new content' })
    expect(result.isError).toBe(false)
    const content = await readFile(path, 'utf-8')
    expect(content).toBe('new content')
  })

  it('creates parent directories', async () => {
    const path = join(dir, 'deep', 'nested', 'file.txt')
    const result = await write.execute({ path, content: 'deep' })
    expect(result.isError).toBe(false)
    const content = await readFile(path, 'utf-8')
    expect(content).toBe('deep')
  })

  it('writes empty content', async () => {
    const path = join(dir, 'empty.txt')
    const result = await write.execute({ path, content: '' })
    expect(result.isError).toBe(false)
    const content = await readFile(path, 'utf-8')
    expect(content).toBe('')
  })

  it('writes UTF-8 content correctly', async () => {
    const path = join(dir, 'utf8.txt')
    const text = '你好世界 🌍'
    const result = await write.execute({ path, content: text })
    expect(result.isError).toBe(false)
    const content = await readFile(path, 'utf-8')
    expect(content).toBe(text)
  })

  it('reports byte count in metadata', async () => {
    const path = join(dir, 'meta.txt')
    const result = await write.execute({ path, content: 'abc' })
    expect(result.metadata?.bytes).toBe(3)
  })

  it('tags create kind and captures newContent when file is new', async () => {
    const path = join(dir, 'create-meta.txt')
    const result = await write.execute({ path, content: 'first\ncontent\n' })
    expect(result.metadata?.changeKind).toBe('create')
    expect(result.metadata?.created).toBe(true)
    expect(result.metadata?.oldContent).toBeNull()
    expect(result.metadata?.newContent).toBe('first\ncontent\n')
  })

  it('tags overwrite kind and captures old + new content for diff', async () => {
    const path = join(dir, 'overwrite-meta.txt')
    await writeFile(path, 'old\nbody\n')
    const result = await write.execute({ path, content: 'new\nbody\n' })
    expect(result.metadata?.changeKind).toBe('overwrite')
    expect(result.metadata?.created).toBe(false)
    expect(result.metadata?.oldContent).toBe('old\nbody\n')
    expect(result.metadata?.newContent).toBe('new\nbody\n')
  })
})
