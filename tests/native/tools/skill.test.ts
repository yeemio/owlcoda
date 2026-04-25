import { describe, it, expect } from 'vitest'
import { createSkillTool } from '../../../src/native/tools/skill.js'

describe('Skill tool', () => {
  const tool = createSkillTool()

  it('requires skill name', async () => {
    const result = await tool.execute({ skill: '' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('required')
  })

  it('has correct name', () => {
    expect(tool.name).toBe('Skill')
  })

  it('reports missing skill', async () => {
    const result = await tool.execute({ skill: 'nonexistent-skill-xyz' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('not found')
  })
})
