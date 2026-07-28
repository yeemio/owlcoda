import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const openBoundary = vi.hoisted(() => ({
  target: '',
  beforeOpen: undefined as undefined | (() => void),
}))

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    openSync(file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) {
      if (file === openBoundary.target) openBoundary.beforeOpen?.()
      return actual.openSync(file, flags, mode)
    },
  }
})

import { loadProjectInstructions } from '../../src/native/project-instructions.js'

const sandboxes: string[] = []

afterEach(() => {
  openBoundary.target = ''
  openBoundary.beforeOpen = undefined
  for (const sandbox of sandboxes.splice(0)) {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

describe('project instruction descriptor identity', () => {
  it('rejects an instruction when an ancestor is replaced between validation and open', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owlcoda-project-instructions-race-'))
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owlcoda-project-instructions-outside-'))
    sandboxes.push(projectRoot, outsideDir)
    fs.mkdirSync(path.join(projectRoot, '.git'))
    const instructionDir = path.join(projectRoot, '.owlcoda')
    const parkedDir = path.join(projectRoot, '.owlcoda-safe')
    const instructionPath = path.join(instructionDir, 'OWLCODA.md')
    fs.mkdirSync(instructionDir)
    fs.writeFileSync(instructionPath, 'reviewed project instruction')
    fs.writeFileSync(path.join(outsideDir, 'OWLCODA.md'), 'outside replacement instruction')

    openBoundary.target = instructionPath
    openBoundary.beforeOpen = () => {
      openBoundary.beforeOpen = undefined
      fs.renameSync(instructionDir, parkedDir)
      fs.symlinkSync(outsideDir, instructionDir, 'dir')
    }

    const sources = loadProjectInstructions(projectRoot)

    expect(sources).toEqual([])
    expect(JSON.stringify(sources)).not.toContain('outside replacement instruction')
  })
})
