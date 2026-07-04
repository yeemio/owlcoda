import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  inspectInstructionChain,
  loadGlobalInstructions,
  loadProjectInstructions,
  renderProjectInstructions,
} from '../../src/native/project-instructions.js'

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

  it('uses AGENTS.override.md instead of AGENTS.md in the same directory', () => {
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.override.md'), 'temporary override rules')
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'base agents rules')
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), 'claude rules')

    const sources = loadProjectInstructions(tmpDir)

    expect(sources.map((source) => [source.name, source.content])).toEqual([
      ['AGENTS.override.md', 'temporary override rules'],
      ['CLAUDE.md', 'claude rules'],
    ])
  })

  it('renders ancestor instructions before cwd instructions so local rules win by position', () => {
    const nested = path.join(tmpDir, 'packages', 'app')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'root agents')
    fs.writeFileSync(path.join(nested, 'CLAUDE.md'), 'nested claude')

    const sources = loadProjectInstructions(nested)

    expect(sources.map((source) => source.name)).toEqual([
      '../../AGENTS.md',
      'CLAUDE.md',
    ])
    expect(sources.map((source) => source.content)).toEqual([
      'root agents',
      'nested claude',
    ])
  })

  it('uses ~/.owlcoda/AGENTS.md before falling back to ~/.codex/AGENTS.md', () => {
    const homeDir = path.join(tmpDir, 'home')
    const builtinPath = path.join(tmpDir, 'builtin-AGENTS.md')
    fs.mkdirSync(path.join(homeDir, '.owlcoda'), { recursive: true })
    fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true })
    fs.writeFileSync(builtinPath, 'built-in rules')
    fs.writeFileSync(path.join(homeDir, '.owlcoda', 'AGENTS.md'), 'owlcoda user rules')
    fs.writeFileSync(path.join(homeDir, '.codex', 'AGENTS.md'), 'codex user rules')

    const sources = loadGlobalInstructions({ builtinPath, homeDir })

    expect(sources.map((source) => [source.name, source.content])).toEqual([
      ['builtin:AGENTS.md', 'built-in rules'],
      ['user:~/.owlcoda/AGENTS.md', 'owlcoda user rules'],
    ])
  })

  it('falls back to ~/.codex/AGENTS.md when OwlCoda user instructions are absent', () => {
    const homeDir = path.join(tmpDir, 'home')
    const builtinPath = path.join(tmpDir, 'builtin-AGENTS.md')
    fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true })
    fs.writeFileSync(builtinPath, 'built-in rules')
    fs.writeFileSync(path.join(homeDir, '.codex', 'AGENTS.md'), 'codex user rules')

    const sources = loadGlobalInstructions({ builtinPath, homeDir })

    expect(sources.map((source) => [source.name, source.content])).toEqual([
      ['builtin:AGENTS.md', 'built-in rules'],
      ['user:~/.codex/AGENTS.md', 'codex user rules'],
    ])
  })

  it('does not fall back to ~/.codex/AGENTS.md when ~/.owlcoda/AGENTS.md exists but is empty', () => {
    const homeDir = path.join(tmpDir, 'home')
    const builtinPath = path.join(tmpDir, 'builtin-AGENTS.md')
    fs.mkdirSync(path.join(homeDir, '.owlcoda'), { recursive: true })
    fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true })
    fs.writeFileSync(builtinPath, 'built-in rules')
    fs.writeFileSync(path.join(homeDir, '.owlcoda', 'AGENTS.md'), '')
    fs.writeFileSync(path.join(homeDir, '.codex', 'AGENTS.md'), 'codex user rules')

    const sources = loadGlobalInstructions({ builtinPath, homeDir })

    expect(sources.map((source) => [source.name, source.content])).toEqual([
      ['builtin:AGENTS.md', 'built-in rules'],
    ])
  })

  it('inspect reports skipped instruction sources with reasons', () => {
    const homeDir = path.join(tmpDir, 'home')
    const builtinPath = path.join(tmpDir, 'builtin-AGENTS.md')
    const rulesDir = path.join(tmpDir, '.claude', 'rules')
    fs.mkdirSync(path.join(homeDir, '.owlcoda'), { recursive: true })
    fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true })
    fs.mkdirSync(rulesDir, { recursive: true })
    fs.writeFileSync(builtinPath, 'built-in rules')
    fs.writeFileSync(path.join(homeDir, '.owlcoda', 'AGENTS.md'), 'owlcoda user rules')
    fs.writeFileSync(path.join(homeDir, '.codex', 'AGENTS.md'), 'codex user rules')
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.override.md'), 'project override')
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'project base')
    fs.writeFileSync(path.join(rulesDir, 'api.md'), [
      '---',
      'paths:',
      '  - "src/api/**/*.ts"',
      '---',
      'api-only rule',
    ].join('\n'))

    const inspection = inspectInstructionChain(tmpDir, { builtinPath, homeDir })

    expect(inspection.limits).toEqual({
      maxBytesPerFile: 16 * 1024,
      maxSearchDepth: 6,
      maxRuleFiles: 32,
    })
    expect(inspection.sources.map((source) => source.name)).toEqual([
      'builtin:AGENTS.md',
      'user:~/.owlcoda/AGENTS.md',
      'AGENTS.override.md',
    ])
    expect(inspection.skipped.map((source) => [source.reason, source.name])).toEqual([
      ['fallback-not-used', 'user:~/.codex/AGENTS.md'],
      ['shadowed-by-override', 'AGENTS.md'],
      ['path-scoped-rule', '.claude/rules/api.md'],
    ])
  })

  it('reports a broken OwlCoda user symlink and still stops Codex fallback', () => {
    const homeDir = path.join(tmpDir, 'home')
    const builtinPath = path.join(tmpDir, 'builtin-AGENTS.md')
    const owlCodaDir = path.join(homeDir, '.owlcoda')
    fs.mkdirSync(owlCodaDir, { recursive: true })
    fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true })
    fs.writeFileSync(builtinPath, 'built-in rules')
    fs.symlinkSync(path.join(owlCodaDir, 'missing-target.md'), path.join(owlCodaDir, 'AGENTS.md'))
    fs.writeFileSync(path.join(homeDir, '.codex', 'AGENTS.md'), 'codex user rules')

    const inspection = inspectInstructionChain(tmpDir, { builtinPath, homeDir })

    expect(inspection.sources.map((source) => source.name)).toEqual(['builtin:AGENTS.md'])
    expect(inspection.skipped.map((source) => [source.reason, source.name])).toEqual([
      ['read-error', 'user:~/.owlcoda/AGENTS.md'],
      ['fallback-not-used', 'user:~/.codex/AGENTS.md'],
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

  it('does not load path-scoped Claude rules at startup', () => {
    const rulesDir = path.join(tmpDir, '.claude', 'rules')
    fs.mkdirSync(rulesDir, { recursive: true })
    fs.writeFileSync(path.join(rulesDir, 'general.md'), 'general rule')
    fs.writeFileSync(path.join(rulesDir, 'api.md'), [
      '---',
      'paths:',
      '  - "src/api/**/*.ts"',
      '---',
      'api-only rule',
    ].join('\n'))

    const sources = loadProjectInstructions(tmpDir)

    expect(sources.map((source) => [source.name, source.content])).toEqual([
      ['.claude/rules/general.md', 'general rule'],
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
