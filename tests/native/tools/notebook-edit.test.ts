import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createNotebookEditTool } from '../../../src/native/tools/notebook-edit.js'

function makeTmpDir(): string {
  const dir = join(tmpdir(), `owlcoda-nb-test-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeNotebook(dir: string, cells: unknown[] = [], nbformat = 4, nbformat_minor = 5) {
  const nb = {
    nbformat,
    nbformat_minor,
    metadata: { language_info: { name: 'python' } },
    cells,
  }
  const path = join(dir, 'test.ipynb')
  writeFileSync(path, JSON.stringify(nb, null, 2))
  return path
}

describe('NotebookEdit tool', () => {
  const tool = createNotebookEditTool()
  let tmpDir: string
  let prevAllow: string | undefined

  beforeEach(() => {
    tmpDir = makeTmpDir()
    prevAllow = process.env['OWLCODA_ALLOW_FS_ROOTS']
    process.env['OWLCODA_ALLOW_FS_ROOTS'] = tmpDir
  })
  afterEach(() => {
    if (prevAllow === undefined) delete process.env['OWLCODA_ALLOW_FS_ROOTS']
    else process.env['OWLCODA_ALLOW_FS_ROOTS'] = prevAllow
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true })
  })

  it('has correct name and description', () => {
    expect(tool.name).toBe('NotebookEdit')
    expect(tool.description).toContain('Jupyter')
  })

  it('replaces a code cell by ID', async () => {
    const path = makeNotebook(tmpDir, [
      { cell_type: 'code', id: 'abc123', source: 'x = 1', metadata: {}, execution_count: 5, outputs: [{ text: 'hi' }] },
    ])
    const result = await tool.execute({
      notebook_path: path,
      cell_id: 'abc123',
      new_source: 'x = 42',
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Updated')
    // Verify file was actually changed
    const updated = JSON.parse(require('fs').readFileSync(path, 'utf-8'))
    expect(updated.cells[0].source).toBe('x = 42')
    expect(updated.cells[0].execution_count).toBeNull()
    expect(updated.cells[0].outputs).toEqual([])
  })

  it('replaces a cell by cell-N index', async () => {
    const path = makeNotebook(tmpDir, [
      { cell_type: 'code', id: 'a', source: 'first', metadata: {} },
      { cell_type: 'code', id: 'b', source: 'second', metadata: {} },
    ])
    const result = await tool.execute({
      notebook_path: path,
      cell_id: 'cell-1',
      new_source: 'replaced',
    })
    expect(result.isError).toBe(false)
    const updated = JSON.parse(require('fs').readFileSync(path, 'utf-8'))
    expect(updated.cells[1].source).toBe('replaced')
  })

  it('inserts a new cell', async () => {
    const path = makeNotebook(tmpDir, [
      { cell_type: 'code', id: 'a', source: 'first', metadata: {} },
    ])
    const result = await tool.execute({
      notebook_path: path,
      cell_id: 'a',
      new_source: '# New markdown',
      cell_type: 'markdown',
      edit_mode: 'insert',
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Inserted')
    const updated = JSON.parse(require('fs').readFileSync(path, 'utf-8'))
    expect(updated.cells).toHaveLength(2)
    expect(updated.cells[1].cell_type).toBe('markdown')
    expect(updated.cells[1].source).toBe('# New markdown')
  })

  it('deletes a cell', async () => {
    const path = makeNotebook(tmpDir, [
      { cell_type: 'code', id: 'a', source: 'keep', metadata: {} },
      { cell_type: 'code', id: 'b', source: 'delete-me', metadata: {} },
    ])
    const result = await tool.execute({
      notebook_path: path,
      cell_id: 'b',
      new_source: '',
      edit_mode: 'delete',
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Deleted')
    const updated = JSON.parse(require('fs').readFileSync(path, 'utf-8'))
    expect(updated.cells).toHaveLength(1)
    expect(updated.cells[0].id).toBe('a')
  })

  it('rejects non-.ipynb file', async () => {
    // Keep the path inside the allowed workspace root so the extension
    // check (rather than the fs-policy guard) is what trips. The guard
    // is a lower-precedence concern here — separately covered.
    const result = await tool.execute({
      notebook_path: join(tmpDir, 'test.py'),
      new_source: 'x = 1',
    })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('.ipynb')
  })

  it('rejects missing cell_id for replace', async () => {
    const path = makeNotebook(tmpDir, [
      { cell_type: 'code', id: 'a', source: 'x', metadata: {} },
    ])
    const result = await tool.execute({
      notebook_path: path,
      new_source: 'y',
      edit_mode: 'replace',
    })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('cell_id must be specified')
  })

  it('rejects insert without cell_type', async () => {
    const path = makeNotebook(tmpDir, [
      { cell_type: 'code', id: 'a', source: 'x', metadata: {} },
    ])
    const result = await tool.execute({
      notebook_path: path,
      cell_id: 'a',
      new_source: 'y',
      edit_mode: 'insert',
    })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('cell_type is required')
  })

  it('errors on nonexistent notebook', async () => {
    const result = await tool.execute({
      notebook_path: join(tmpDir, 'nope.ipynb'),
      cell_id: 'a',
      new_source: 'y',
    })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('does not exist')
  })

  it('errors on cell not found', async () => {
    const path = makeNotebook(tmpDir, [
      { cell_type: 'code', id: 'a', source: 'x', metadata: {} },
    ])
    const result = await tool.execute({
      notebook_path: path,
      cell_id: 'nonexistent',
      new_source: 'y',
    })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('not found')
  })
})
