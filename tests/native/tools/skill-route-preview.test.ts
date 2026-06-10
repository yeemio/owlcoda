import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillRoutePreviewTool } from '../../../src/native/tools/skill-route-preview.js'
import { NATIVE_TOOL_SCHEMAS } from '../../../src/native/tool-defs.js'

describe('SkillRoutePreview native tool', () => {
  let tempDir = ''
  let previousHome: string | undefined

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'owlcoda-native-skill-route-preview-'))
    previousHome = process.env['OWLCODA_HOME']
    process.env['OWLCODA_HOME'] = tempDir
    await installGuizangFixture(tempDir)
  })

  afterEach(async () => {
    if (previousHome === undefined) delete process.env['OWLCODA_HOME']
    else process.env['OWLCODA_HOME'] = previousHome
    await rm(tempDir, { recursive: true, force: true })
  })

  it('exposes a schema requiring prompt', () => {
    expect(NATIVE_TOOL_SCHEMAS['SkillRoutePreview']).toMatchObject({
      type: 'object',
      required: ['prompt'],
    })
  })

  it('returns JSON skill routing output without creating requested artifacts', async () => {
    const tool = createSkillRoutePreviewTool()
    const outputDir = join(tempDir, 'requested-output')
    const result = await tool.execute({
      prompt: `先不要真正生成文件。我要把 /tmp/source.md 重构成 46 页 HTML PPT，
输出到 ${outputDir}/deck.html，并输出 build-notes.md。`,
    })

    expect(result.isError).toBe(false)
    const payload = JSON.parse(result.output) as Record<string, unknown>
    expect(payload).toMatchObject({
      taskFamily: 'deck',
      deliverableMode: 'file_artifact_delivery',
      selectedSkill: 'guizang-ppt-skill',
      skillPath: join(tempDir, 'skills', 'guizang-ppt-skill', 'SKILL.md'),
      confidence: 'high',
    })
    expect(payload.references).toEqual(['references/themes.md'])
    expect(payload.assets).toEqual(['assets/template.html'])
    expect(existsSync(outputDir)).toBe(false)
  })

  it('returns a clear error for missing prompt', async () => {
    const result = await createSkillRoutePreviewTool().execute({ prompt: '' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('prompt is required')
  })
})

async function installGuizangFixture(root: string): Promise<void> {
  const skillDir = join(root, 'skills', 'guizang-ppt-skill')
  await mkdir(join(skillDir, 'references'), { recursive: true })
  await mkdir(join(skillDir, 'assets'), { recursive: true })
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---
name: guizang-ppt-skill
description: Generate horizontal HTML PPT decks with local references and assets.
when_to_use: Use for HTML PPT and web deck artifact generation.
---

# Guizang PPT Skill
`,
    'utf8',
  )
  await writeFile(join(skillDir, 'references', 'themes.md'), '# Themes\n', 'utf8')
  await writeFile(join(skillDir, 'assets', 'template.html'), '<!doctype html>\n', 'utf8')
}
