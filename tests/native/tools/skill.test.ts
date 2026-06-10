import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillTool } from '../../../src/native/tools/skill.js'

describe('Skill tool', () => {
  const tool = createSkillTool()
  let tempDir: string
  let origHome: string | undefined

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'owlcoda-native-skill-test-'))
    origHome = process.env['OWLCODA_HOME']
    process.env['OWLCODA_HOME'] = tempDir
  })

  afterEach(async () => {
    if (origHome !== undefined) process.env['OWLCODA_HOME'] = origHome
    else delete process.env['OWLCODA_HOME']
    await rm(tempDir, { recursive: true, force: true })
  })

  it('has correct name', () => {
    expect(tool.name).toBe('Skill')
  })

  describe('action: list', () => {
    it('does NOT require a name', async () => {
      const result = await tool.execute({ action: 'list' })
      expect(result.isError).toBe(false)
      expect(result.output).not.toContain('skill name is required')
    })

    it('returns a skill list (possibly empty) with metadata', async () => {
      const result = await tool.execute({ action: 'list' })
      expect(result.isError).toBe(false)
      expect(Array.isArray(result.metadata?.skills)).toBe(true)
      expect(typeof result.metadata?.count).toBe('number')
    })

    it('ignores a stray name argument when listing', async () => {
      const result = await tool.execute({ action: 'list', name: 'unused' })
      expect(result.isError).toBe(false)
    })
  })

  describe('action: get / run / info / show — name required', () => {
    it('action=get without name returns clear error', async () => {
      const result = await tool.execute({ action: 'get' })
      expect(result.isError).toBe(true)
      expect(result.output).toContain('skill name is required')
      expect(result.output).toContain('get')
    })

    it('action=run without name returns clear error', async () => {
      const result = await tool.execute({ action: 'run' })
      expect(result.isError).toBe(true)
      expect(result.output).toContain('skill name is required')
    })

    it('action=info without name returns clear error', async () => {
      const result = await tool.execute({ action: 'info' })
      expect(result.isError).toBe(true)
      expect(result.output).toContain('skill name is required')
    })

    it('action=show with a name passes the param check (skill not-found is a different error)', async () => {
      const result = await tool.execute({ action: 'show', name: 'whatever-nonexistent-xyz' })
      // Param check passed — failure mode here is "not found", not "name required".
      expect(result.output).not.toContain('skill name is required')
      expect(result.isError).toBe(true)
      expect(result.output).toContain('not found')
    })

    it('action=run returns original SKILL.md for learned Claude-style skill packages', async () => {
      const content = `---
name: Guizang PPT Skill
description: Generate horizontal web PPT decks
---

# Magazine Web PPT

## Workflow
Use the bundled references to generate one HTML deck.`
      const dir = join(tempDir, 'skills', 'guizang-ppt-skill')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), content, 'utf-8')

      const result = await tool.execute({ action: 'run', name: 'guizang-ppt-skill' })

      expect(result.isError).toBe(false)
      expect(result.output).toBe(content)
      expect(result.metadata?.skill).toMatchObject({ id: 'guizang-ppt-skill' })
    })
  })

  describe('unknown actions', () => {
    it('returns a clear error for unknown action strings', async () => {
      const result = await tool.execute({ action: 'frobnicate', name: 'x' })
      expect(result.isError).toBe(true)
      expect(result.output).toContain('unknown action')
    })
  })

  describe('legacy { skill: "<name>" } shape', () => {
    it('reports missing skill via the legacy shape', async () => {
      const result = await tool.execute({ skill: 'nonexistent-skill-xyz' })
      expect(result.isError).toBe(true)
      expect(result.output).toContain('not found')
    })

    it('empty legacy skill string still errors with name-required', async () => {
      const result = await tool.execute({ skill: '' })
      expect(result.isError).toBe(true)
      expect(result.output).toContain('required')
    })
  })
})
