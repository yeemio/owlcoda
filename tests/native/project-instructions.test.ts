import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { loadProjectInstructions, renderProjectInstructions } from '../../src/native/project-instructions.js'

describe('project instructions loader', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owlcoda-project-instructions-'))
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('loads AGENTS.md, CLAUDE.md, OWLCODA.md, and .owlcoda/OWLCODA.md in same-directory precedence order', () => {
    fs.mkdirSync(path.join(tmpDir, '.owlcoda'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'agents rules')
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), 'claude rules')
    fs.writeFileSync(path.join(tmpDir, 'OWLCODA.md'), 'owlcoda rules')
    fs.writeFileSync(path.join(tmpDir, '.owlcoda', 'OWLCODA.md'), 'owlcoda nested rules')

    const sources = loadProjectInstructions(tmpDir)

    expect(sources.map((source) => source.name)).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
      'OWLCODA.md',
      '.owlcoda/OWLCODA.md',
    ])
    expect(sources.map((source) => source.content)).toEqual([
      'agents rules',
      'claude rules',
      'owlcoda rules',
      'owlcoda nested rules',
    ])
  })

  it('searches from cwd up to the git root and labels ancestor sources relative to cwd', () => {
    const nested = path.join(tmpDir, 'packages', 'app')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'root agents')
    fs.writeFileSync(path.join(nested, 'CLAUDE.md'), 'nested claude')

    const sources = loadProjectInstructions(nested)

    expect(sources.map((source) => source.name)).toEqual([
      'CLAUDE.md',
      '../../AGENTS.md',
    ])
    expect(sources.map((source) => source.content)).toEqual([
      'nested claude',
      'root agents',
    ])
  })

  it('preserves the legacy OWLCODA.md rendering shape for system prompt injection', () => {
    fs.writeFileSync(path.join(tmpDir, 'OWLCODA.md'), '# OwlCoda Config\nCustom rules here')

    expect(renderProjectInstructions(tmpDir)).toBe(
      '<project_instructions source="OWLCODA.md">\n# OwlCoda Config\nCustom rules here\n</project_instructions>',
    )
  })

  it('loads scoped Claude rules as bounded project instruction sources', () => {
    const rulesDir = path.join(tmpDir, '.claude', 'rules')
    fs.mkdirSync(path.join(rulesDir, 'backend'), { recursive: true })
    fs.writeFileSync(path.join(rulesDir, '00-general.md'), 'general rule')
    fs.writeFileSync(path.join(rulesDir, 'backend', 'api.md'), 'api rule')

    const sources = loadProjectInstructions(tmpDir)

    expect(sources.map((source) => [source.name, source.kind, source.content])).toEqual([
      ['.claude/rules/00-general.md', 'rule', 'general rule'],
      ['.claude/rules/backend/api.md', 'rule', 'api rule'],
    ])
  })

  it('returns null rendering when no instruction files are found', () => {
    expect(renderProjectInstructions(tmpDir)).toBeNull()
  })

  it('caps each instruction file to the configured byte budget', () => {
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'abcdef')

    const sources = loadProjectInstructions(tmpDir, { maxBytesPerFile: 3 })

    expect(sources).toHaveLength(1)
    expect(sources[0]!.content).toBe('abc')
    expect(sources[0]!.bytesRead).toBe(3)
  })
})
