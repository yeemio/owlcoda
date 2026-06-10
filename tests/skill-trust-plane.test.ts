import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { BYPASS_INSTRUCTION_PATTERNS } from '../src/skills/conflict-scan.js'

const repoRoot = join(import.meta.dirname, '..')
const skillsRoot = join(repoRoot, 'skills')

function findSkillMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir).sort()) {
    const fullPath = join(dir, entry)
    const s = statSync(fullPath)
    if (s.isDirectory()) {
      const skillFile = join(fullPath, 'SKILL.md')
      if (existsSync(skillFile)) out.push(skillFile)
      out.push(...findSkillMarkdownFiles(fullPath))
    }
  }
  return out
}

describe('Skill Trust Plane policy', () => {
  it('keeps bundled default-injectable skills free of runtime bypass instructions', () => {
    const files = findSkillMarkdownFiles(skillsRoot)
    expect(files.length).toBeGreaterThan(40)

    const violations: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const { name, pattern } of BYPASS_INSTRUCTION_PATTERNS) {
        const match = text.match(pattern)
        if (match) {
          violations.push(`${file.slice(repoRoot.length + 1)}: ${name}: ${JSON.stringify(match[0])}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('allows explicit anti-bypass guidance', () => {
    const executingPlans = readFileSync(join(skillsRoot, 'collaboration', 'executing-plans', 'SKILL.md'), 'utf8')
    expect(executingPlans).toContain("Don't skip verifications")
    for (const { pattern } of BYPASS_INSTRUCTION_PATTERNS) {
      expect(executingPlans).not.toMatch(pattern)
    }
  })
})

