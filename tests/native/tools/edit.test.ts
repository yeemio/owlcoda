import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createEditTool } from '../../../src/native/tools/edit.js'

describe('Native Edit tool', () => {
  const edit = createEditTool()
  let dir: string
  let prevAllow: string | undefined
  let prevRecovery: string | undefined

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'owlcoda-edit-test-'))
    prevAllow = process.env['OWLCODA_ALLOW_FS_ROOTS']
    prevRecovery = process.env['OWLCODA_RECOVERY_DIR']
    process.env['OWLCODA_ALLOW_FS_ROOTS'] = dir
    process.env['OWLCODA_RECOVERY_DIR'] = join(dir, 'recovery')
  })

  afterAll(async () => {
    if (prevAllow === undefined) delete process.env['OWLCODA_ALLOW_FS_ROOTS']
    else process.env['OWLCODA_ALLOW_FS_ROOTS'] = prevAllow
    if (prevRecovery === undefined) delete process.env['OWLCODA_RECOVERY_DIR']
    else process.env['OWLCODA_RECOVERY_DIR'] = prevRecovery
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

  it('snapshots destructive edits as exact raw bytes before writing', async () => {
    const path = join(dir, 'destructive-binary-edit.bin')
    const text = Array.from({ length: 180 }, (_, index) => `payload ${index}`).join('\n')
    const original = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text)])
    await writeFile(path, original)
    const decoded = await readFile(path, 'utf8')

    const result = await edit.execute({
      path,
      oldStr: decoded,
      newStr: 'replacement\n',
      allowDestructiveOverwrite: true,
    })

    expect(result.isError).toBe(false)
    const snapshotPath = result.metadata?.recoverySnapshotPath as string
    expect(snapshotPath).toBeTruthy()
    expect(await readFile(snapshotPath)).toEqual(original)
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
    // After fs-policy normalization, meta.path is the realpath of the
    // input. On macOS that adds a /private prefix when tmpdir is involved.
    expect(meta.path).toBe(await realpath(path))
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

  // 0.13.59 schema-error path: long-context tool_use with missing
  // fields gets a structured, self-recoverable error.
  describe('schema-error self-recovery (0.13.59)', () => {
    it('edit({}) flags all three required fields', async () => {
      const result = await edit.execute({} as any)
      expect(result.isError).toBe(true)
      expect(result.output).toMatch(/missing required field\(s\): `path`, `oldStr`, `newStr`/)
      expect(result.output).toMatch(/Do NOT retry the same input shape/)
      expect(result.metadata?.['schemaError']).toBe(true)
      expect(result.metadata?.['missingFields']).toEqual(['path', 'oldStr', 'newStr'])
    })

    it('edit({path}) flags missing oldStr + newStr', async () => {
      const result = await edit.execute({ path: '/tmp/x' } as any)
      expect(result.isError).toBe(true)
      expect(result.metadata?.['missingFields']).toEqual(['oldStr', 'newStr'])
    })

    it('edit with empty newStr (intentional deletion) is NOT flagged', async () => {
      const path = join(dir, 'delete-test.txt')
      await writeFile(path, 'keep this\nremove this line\nand keep this\n')
      const result = await edit.execute({
        path,
        oldStr: 'remove this line\n',
        newStr: '',
      })
      expect(result.isError).toBe(false)
    })
  })

  // 0.13.59 oldStr-not-found enrichment: line-ending diagnostic +
  // fuzzy candidates. The CRLF-vs-LF case is the specific failure
  // we hit in the sieracMes-AI dogfood.
  describe('oldStr-not-found diagnostics (0.13.59)', () => {
    it('CRLF file edited with LF oldStr returns the line-ending hint', async () => {
      const path = join(dir, 'crlf-file.txt')
      await writeFile(path, 'first line\r\nsecond line\r\nthird line\r\n')
      const result = await edit.execute({
        path,
        oldStr: 'second line\nthird line',
        newStr: 'replacement',
      })
      expect(result.isError).toBe(true)
      expect(result.output).toMatch(/CRLF line endings/)
      expect(result.output).toMatch(/oldStr.*LF/)
      expect(result.metadata?.['fileLineEnding']).toBe('CRLF')
      expect(result.metadata?.['oldStrLineEnding']).toBe('LF')
    })

    it('returns fuzzy-match candidates when no exact match exists', async () => {
      const path = join(dir, 'fuzzy-file.txt')
      await writeFile(path, 'foo bar\nthis is the actual line in the file\nbaz qux\n')
      const result = await edit.execute({
        path,
        oldStr: 'this is the actuall line in the fil',
        newStr: 'replacement',
      })
      expect(result.isError).toBe(true)
      expect(result.output).toMatch(/Closest matches/)
      expect(result.output).toMatch(/line 2/)
      expect(result.output).toMatch(/this is the actual line in the file/)
    })

    it('falls back to "no similar lines found" when nothing is close', async () => {
      const path = join(dir, 'no-fuzzy-file.txt')
      await writeFile(path, 'foo\nbar\nbaz\n')
      const result = await edit.execute({
        path,
        oldStr: 'completely unrelated zorgblat needle',
        newStr: 'replacement',
      })
      expect(result.isError).toBe(true)
      expect(result.output).toMatch(/No similar lines found/)
    })
  })

  it('multi-occurrence error tells the model to add surrounding context (0.13.59)', async () => {
    const path = join(dir, 'multi-file.txt')
    await writeFile(path, 'foo\nfoo\nfoo\n')
    const result = await edit.execute({
      path,
      oldStr: 'foo',
      newStr: 'bar',
    })
    expect(result.isError).toBe(true)
    // 0.13.60: wording slightly changed (now "add 1-3 lines" lowercase
    // and references replaceAll as option (c))
    expect(result.output).toMatch(/add 1-3 lines of surrounding context/)
    expect(result.output).toMatch(/replaceAll: true/)
    expect(result.metadata?.['occurrencesFound']).toBe(3)
    expect(result.metadata?.['replaceAllAvailable']).toBe(true)
  })

  // 0.13.60: replaceAll opt-in for renames / mass refactors.
  describe('replaceAll opt-in (0.13.60)', () => {
    it('replaces every occurrence when replaceAll=true', async () => {
      const path = join(dir, 'rename-test.txt')
      await writeFile(path, 'oldName\noldName\nother\noldName\n')
      const result = await edit.execute({
        path,
        oldStr: 'oldName',
        newStr: 'newName',
        replaceAll: true,
      })
      expect(result.isError).toBe(false)
      expect(result.output).toMatch(/replaced 3 occurrences/)
      expect(result.metadata?.['occurrencesReplaced']).toBe(3)
      expect(result.metadata?.['replaceAllUsed']).toBe(true)
      const after = await readFile(path, 'utf-8')
      expect(after).toBe('newName\nnewName\nother\nnewName\n')
    })

    it('replaceAll=true with single occurrence still works (replaces 1)', async () => {
      const path = join(dir, 'single-replace-all.txt')
      await writeFile(path, 'one\ntwo\nthree\n')
      const result = await edit.execute({
        path,
        oldStr: 'two',
        newStr: 'TWO',
        replaceAll: true,
      })
      expect(result.isError).toBe(false)
      expect(result.output).toMatch(/replaced 1 occurrence/)
      expect(result.metadata?.['occurrencesReplaced']).toBe(1)
    })

    it('replaceAll=false (default) still rejects multi-occurrence', async () => {
      const path = join(dir, 'default-multi.txt')
      await writeFile(path, 'x\nx\n')
      const result = await edit.execute({
        path,
        oldStr: 'x',
        newStr: 'Y',
      })
      expect(result.isError).toBe(true)
      expect(result.metadata?.['occurrencesFound']).toBe(2)
    })
  })
})
