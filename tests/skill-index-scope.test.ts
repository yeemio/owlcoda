import { describe, expect, it } from 'vitest'
import { getSkillIndex, invalidateSkillIndex } from '../src/skills/injection.js'

describe('skill index is project-scoped', () => {
  it('builds and caches a distinct index per projectRoot', async () => {
    invalidateSkillIndex()
    const a = await getSkillIndex('/tmp/project-a')
    const b = await getSkillIndex('/tmp/project-b')
    expect(await getSkillIndex('/tmp/project-a')).toBe(a)   // same root → cached instance
    expect(b).not.toBe(a)                                    // different root → different index
  })
})
