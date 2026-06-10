import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { previewSkillRoute } from '../src/skills/router-preview.js'

let tempDir: string
let origHome: string | undefined

async function installGuizangFixture(): Promise<void> {
  const skillDir = join(tempDir, 'skills', 'guizang-ppt-skill')
  await mkdir(join(skillDir, 'references', 'nested'), { recursive: true })
  await mkdir(join(skillDir, 'assets'), { recursive: true })

  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---
name: guizang-ppt-skill
description: Generate horizontal HTML PPT decks with local references and assets.
when_to_use: Use when users ask to create HTML PPT, web deck, slide deck, or horizontal presentation artifacts.
---

# Magazine Web PPT

## Workflow
Read references and assets before creating the HTML deck.`,
    'utf-8',
  )
  await writeFile(join(skillDir, 'references', 'themes.md'), '# Themes\n', 'utf-8')
  await writeFile(join(skillDir, 'references', 'nested', 'layouts.md'), '# Layouts\n', 'utf-8')
  await writeFile(join(skillDir, 'assets', 'template.html'), '<!doctype html>\n', 'utf-8')
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'owlcoda-skill-router-preview-'))
  origHome = process.env['OWLCODA_HOME']
  process.env['OWLCODA_HOME'] = tempDir
})

afterEach(async () => {
  if (origHome !== undefined) process.env['OWLCODA_HOME'] = origHome
  else delete process.env['OWLCODA_HOME']
  await rm(tempDir, { recursive: true, force: true })
})

describe('Skill Router Preview', () => {
  it('selects guizang-ppt-skill for an HTML PPT artifact prompt and lists package files', async () => {
    await installGuizangFixture()
    const outputDir = join(tempDir, 'requested-output')
    const result = await previewSkillRoute(
      `先不要真正生成文件。请对下面任务做 OwlCoda 执行预演：
我要把 /tmp/source/manuscript.md 重构成 46 页 HTML PPT，
输出到 ${outputDir}/deck.html，并输出 build-notes.md。`,
    )

    expect(result.taskFamily).toBe('deck')
    expect(result.deliverableMode).toBe('file_artifact_delivery')
    expect(result.selectedSkill).toBe('guizang-ppt-skill')
    expect(result.skillPath).toBe(join(tempDir, 'skills', 'guizang-ppt-skill', 'SKILL.md'))
    expect(result.references).toEqual([
      'references/nested/layouts.md',
      'references/themes.md',
    ])
    expect(result.assets).toEqual(['assets/template.html'])
    expect(result.confidence).toBe('high')
    expect(result.reason).toContain('HTML PPT')
    expect(existsSync(outputDir)).toBe(false)
  })

  it('does not select the PPT workflow for read-only review prompts', async () => {
    await installGuizangFixture()
    const result = await previewSkillRoute(
      `请只读评审当前仓库 src/native/task-state.ts 和 src/native/conversation.ts，
找出 Task Execution Mode 相关的 3 个潜在风险。
不要修改文件，不要创建产物，只在聊天里输出评审结论。`,
    )

    expect(result.taskFamily).toBe('code')
    expect(result.deliverableMode).toBe('read_only_review')
    expect(result.selectedSkill).toBeNull()
    expect(result.skillPath).toBeNull()
    expect(result.references).toEqual([])
    expect(result.assets).toEqual([])
  })

  it('does not select the PPT workflow for source code edit prompts mentioning PPT', async () => {
    await installGuizangFixture()
    const result = await previewSkillRoute(
      '请修改 src/skills/injection.ts，修复 HTML PPT prompt 的 skill matcher 误判，并加单测。',
    )

    expect(result.taskFamily).toBe('code')
    expect(result.deliverableMode).toBe('code_change')
    expect(result.selectedSkill).toBeNull()
    expect(result.reason).toContain('source files')
  })

  it('reports a no-match deck route when guizang-ppt-skill is unavailable', async () => {
    const result = await previewSkillRoute(
      '请生成一个 12 页 HTML PPT，输出到 /tmp/owlcoda-preview/deck.html，并输出 build-notes.md。',
      { skills: [] },
    )

    expect(result.taskFamily).toBe('deck')
    expect(result.deliverableMode).toBe('file_artifact_delivery')
    expect(result.selectedSkill).toBeNull()
    expect(result.confidence).toBe('medium')
    expect(result.reason).toContain('guizang-ppt-skill was not found')
  })
})
