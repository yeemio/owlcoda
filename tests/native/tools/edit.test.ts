import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createEditTool } from '../../../src/native/tools/edit.js'

describe('Native Edit tool', () => {
  const edit = createEditTool()
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'owlcoda-edit-test-'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('has correct name', () => {
    expect(edit.name).toBe('edit')
  })

  it('replaces a unique string', async () => {
    const path = join(dir, 'unique.txt')
    await writeFile(path, 'Hello World\nGoodbye World')
    const result = await edit.execute({
      path,
      oldStr: 'Hello World',
      newStr: 'Hi World',
    })
    expect(result.isError).toBe(false)
    const content = await readFile(path, 'utf-8')
    expect(content).toBe('Hi World\nGoodbye World')
  })

  it('errors when oldStr not found', async () => {
    const path = join(dir, 'notfound.txt')
    await writeFile(path, 'alpha beta gamma')
    const result = await edit.execute({
      path,
      oldStr: 'delta',
      newStr: 'epsilon',
    })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('not found')
  })

  it('errors when oldStr is ambiguous (multiple occurrences)', async () => {
    const path = join(dir, 'ambiguous.txt')
    await writeFile(path, 'foo bar foo baz')
    const result = await edit.execute({
      path,
      oldStr: 'foo',
      newStr: 'qux',
    })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('2 times')
  })

  it('errors when oldStr is empty', async () => {
    const path = join(dir, 'empty-old.txt')
    await writeFile(path, 'content')
    const result = await edit.execute({
      path,
      oldStr: '',
      newStr: 'something',
    })
    expect(result.isError).toBe(true)
  })

  it('handles multi-line oldStr', async () => {
    const path = join(dir, 'multiline.txt')
    await writeFile(path, 'line1\nline2\nline3\n')
    const result = await edit.execute({
      path,
      oldStr: 'line1\nline2',
      newStr: 'replaced1\nreplaced2',
    })
    expect(result.isError).toBe(false)
    const content = await readFile(path, 'utf-8')
    expect(content).toBe('replaced1\nreplaced2\nline3\n')
  })

  it('can replace with empty string (deletion)', async () => {
    const path = join(dir, 'delete.txt')
    await writeFile(path, 'keep remove keep')
    const result = await edit.execute({
      path,
      oldStr: ' remove',
      newStr: '',
    })
    expect(result.isError).toBe(false)
    const content = await readFile(path, 'utf-8')
    expect(content).toBe('keep keep')
  })

  it('exposes change-block metadata with start line + kind', async () => {
    const path = join(dir, 'meta.txt')
    await writeFile(path, 'aaa\nbbb\nccc\nTARGET\nddd\neee\nfff\n')
    const result = await edit.execute({
      path,
      oldStr: 'TARGET',
      newStr: 'CHANGED',
    })
    expect(result.isError).toBe(false)
    const meta = result.metadata!
    expect(meta.changeKind).toBe('update')
    expect(meta.path).toBe(path)
    expect(typeof meta.oldContext).toBe('string')
    expect(typeof meta.newContext).toBe('string')
    // Change is on the 4th line (index 3); with 3 context lines above,
    // captured context starts at line 1 (1-based).
    expect(meta.contextStartLine).toBe(1)
    expect((meta.oldContext as string).includes('TARGET')).toBe(true)
    expect((meta.newContext as string).includes('CHANGED')).toBe(true)
  })

  it('errors on non-existent file', async () => {
    const result = await edit.execute({
      path: join(dir, 'nope.txt'),
      oldStr: 'x',
      newStr: 'y',
    })
    expect(result.isError).toBe(true)
  })
})
