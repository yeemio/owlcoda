/**
 * Per-tool fs-policy guard tests — confirms the write/edit/NotebookEdit
 * tools actually invoke the policy and refuse to mutate the filesystem
 * when the target is out of scope.
 *
 * The fs-policy module has its own pure-function tests; here we want to
 * pin the wiring at the tool layer so a refactor can't accidentally
 * detach the guard. Issue #3.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWriteTool } from '../../../src/native/tools/write.js'
import { createEditTool } from '../../../src/native/tools/edit.js'
import { createNotebookEditTool } from '../../../src/native/tools/notebook-edit.js'

let originalCwd: string
let workspace: string
let outsideRoot: string

beforeEach(() => {
  originalCwd = process.cwd()
  workspace = mkdtempSync(join(tmpdir(), 'owlcoda-tool-guard-ws-'))
  outsideRoot = mkdtempSync(join(tmpdir(), 'owlcoda-tool-guard-out-'))
  process.chdir(workspace)
})

afterEach(() => {
  process.chdir(originalCwd)
  try { rmSync(workspace, { recursive: true, force: true }) } catch { /* ignore */ }
  try { rmSync(outsideRoot, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('write tool — fs-policy guard', () => {
  it('writes successfully inside workspace', async () => {
    const tool = createWriteTool()
    const target = join(workspace, 'hello.txt')
    const result = await tool.execute({ path: target, content: 'hi' } as any)
    expect(result.isError).toBe(false)
    expect(readFileSync(target, 'utf-8')).toBe('hi')
  })

  it('refuses to write outside workspace and never creates the file', async () => {
    const tool = createWriteTool()
    const target = join(outsideRoot, 'pwn.txt')
    const result = await tool.execute({ path: target, content: 'pwn' } as any)
    expect(result.isError).toBe(true)
    expect(String(result.output)).toMatch(/outside the allowed workspace/)
    expect(existsSync(target)).toBe(false)
    expect(result.metadata?.['fsPolicyDenied']).toBe(true)
  })

  it('refuses ../ traversal escape', async () => {
    const tool = createWriteTool()
    // workspace/../escape.txt — sibling of workspace, definitely outside.
    const result = await tool.execute({ path: '../escape.txt', content: 'pwn' } as any)
    expect(result.isError).toBe(true)
    expect(existsSync(join(workspace, '..', 'escape.txt'))).toBe(false)
  })

  it('refuses empty path', async () => {
    const tool = createWriteTool()
    const result = await tool.execute({ path: '', content: 'pwn' } as any)
    expect(result.isError).toBe(true)
    expect(String(result.output)).toMatch(/non-empty string/)
  })
})

describe('edit tool — fs-policy guard', () => {
  it('edits successfully inside workspace', async () => {
    const tool = createEditTool()
    const target = join(workspace, 'a.txt')
    writeFileSync(target, 'hello world')
    const result = await tool.execute({ path: target, oldStr: 'world', newStr: 'planet' } as any)
    expect(result.isError).toBe(false)
    expect(readFileSync(target, 'utf-8')).toBe('hello planet')
  })

  it('refuses to edit a file outside workspace (and does not modify it)', async () => {
    const tool = createEditTool()
    const target = join(outsideRoot, 'precious.txt')
    writeFileSync(target, 'untouched')
    const result = await tool.execute({ path: target, oldStr: 'untouched', newStr: 'pwn' } as any)
    expect(result.isError).toBe(true)
    expect(String(result.output)).toMatch(/outside the allowed workspace/)
    expect(readFileSync(target, 'utf-8')).toBe('untouched')
  })
})

describe('NotebookEdit tool — fs-policy guard', () => {
  it('refuses to edit a notebook outside workspace', async () => {
    const tool = createNotebookEditTool()
    const target = join(outsideRoot, 'pwn.ipynb')
    writeFileSync(target, JSON.stringify({
      nbformat: 4, nbformat_minor: 5, metadata: {},
      cells: [{ cell_type: 'code', id: 'cell-0', source: 'print("hi")', metadata: {} }],
    }))
    const result = await tool.execute({
      notebook_path: target,
      cell_id: 'cell-0',
      new_source: 'print("pwn")',
    } as any)
    expect(result.isError).toBe(true)
    expect(String(result.output)).toMatch(/outside the allowed workspace/)
    // Original content unchanged.
    const after = JSON.parse(readFileSync(target, 'utf-8'))
    expect(after.cells[0].source).toBe('print("hi")')
  })
})
