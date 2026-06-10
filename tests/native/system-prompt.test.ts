import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'

import { buildSystemPrompt } from '../../src/native/system-prompt.js'

describe('buildSystemPrompt', () => {
  it('returns a non-empty string', () => {
    const prompt = buildSystemPrompt()
    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(100)
  })

  it('includes OwlCoda identity', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('OwlCoda')
  })

  it('includes environment section with CWD', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('<environment>')
    expect(prompt).toContain('Working directory:')
    expect(prompt).toContain(process.cwd())
  })

  it('includes OS information', () => {
    const prompt = buildSystemPrompt()
    // Should contain macOS or Linux or the platform name
    expect(prompt).toMatch(/OS: (macOS|Linux|win32|darwin|linux)/)
  })

  it('includes shell information', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('Shell:')
  })

  it('includes tool guidelines by default', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('<tool_guidelines>')
    expect(prompt).toContain('read')
    expect(prompt).toContain('edit')
    expect(prompt).toContain('bash')
  })

  it('can exclude tool guidelines', () => {
    const prompt = buildSystemPrompt({ includeToolDescriptions: false })
    expect(prompt).not.toContain('<tool_guidelines>')
  })

  it('includes behavioral rules', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('# Doing tasks')
    expect(prompt).toContain('# Output')
  })

  // 0.13.58: investigate-before-asking discipline. The mionyee
  // long-context dogfood showed deepseek-v4-pro reflexively bouncing
  // clarifying questions back at the user instead of grepping the
  // repo for answers already in scope. New section makes the rule
  // explicit AND names the "you go find it" pattern operators
  // routinely use.
  it('includes investigation-before-asking discipline (0.13.58)', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('# Investigation before asking')
    expect(prompt).toMatch(/exhaust read-only investigation/)
    expect(prompt).toMatch(/look it up.*去找.*查一下.*you go find/)
    expect(prompt).toMatch(/ALWAYS investigate first/)
  })

  it('drops the legacy "system will detect and terminate" threat phrasing (0.13.58)', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).not.toMatch(/will detect and terminate sessions/)
  })

  // 0.13.71 execution_economics_v1 — failure_ladder_prompt_v1.
  // Three-tier failure response (read error → change strategy →
  // stop and ask) makes Codex/Sonnet 4's implicit discipline
  // explicit so weaker models adopt it. Coexists with the runtime
  // soft loop intercept (0.13.55).
  it('includes the failure ladder section (0.13.71)', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('# Failure ladder')
    expect(prompt).toMatch(/First failure/)
    expect(prompt).toMatch(/Second same-shape failure/)
    expect(prompt).toMatch(/Third same-intent failure/)
    expect(prompt).toMatch(/STOP calling tools/)
    expect(prompt).toMatch(/Known Unverified Item/)
    expect(prompt).toMatch(/Never retry an identical tool input/)
  })

  // 0.13.71 execution_economics_v1 — evidence-first tool ordering
  // (mechanism #7). Cheap narrow tools before expensive broad
  // reads. Names the runtime nudges that fire when the model
  // re-reads or re-greps so the model recognizes them as hard
  // signals to stop and synthesize.
  it('includes the evidence-first tool ordering section (0.13.71)', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('# Evidence-first tool ordering')
    expect(prompt).toMatch(/Already-gathered evidence/)
    expect(prompt).toMatch(/grep \/ search for a specific symbol/)
    expect(prompt).toMatch(/glob for a file list/)
    expect(prompt).toMatch(/read with a line range/)
    expect(prompt).toMatch(/read full file.*last resort/i)
    expect(prompt).toMatch(/Re-reading rarely produces new information/)
  })

  it('includes artifact task routing, workspace, and verification repair instructions', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('# Task execution mode')
    expect(prompt).toContain('SkillRoutePreview')
    expect(prompt).toContain('RunWorkspace')
    expect(prompt).toContain('verification_pack/html_deck')
    expect(prompt).toContain('ArtifactVerify')
    expect(prompt).toMatch(/repair the artifact/i)
  })

  // 0.13.59 retry discipline. Pre-0.13.59 the rule was just "If an
  // approach fails, diagnose root cause before switching. No identical
  // retries." — too soft. The sieracMes-AI dogfood showed the model
  // still emitting the SAME write({}) three times in a row. The new
  // rule names the contract: read the error, change something material
  // by attempt three, or stop and ask. Plus an explicit schema-error
  // handling line that points at the new structured error path.
  it('includes tightened retry discipline + schema-error handling rules (0.13.59)', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toMatch(/READ tool errors before retrying/)
    expect(prompt).toMatch(/EXACT same tool input has now failed twice/)
    expect(prompt).toMatch(/change something material on the third attempt/)
    expect(prompt).toMatch(/SCHEMA error.*missing\/empty required field/)
    expect(prompt).toMatch(/Don't guess at the schema/)
  })

  it('uses custom CWD when provided', () => {
    const prompt = buildSystemPrompt({ cwd: '/tmp/test-project' })
    expect(prompt).toContain('/tmp/test-project')
  })

  it('appends extra context when provided', () => {
    const prompt = buildSystemPrompt({ extraContext: 'This is a Python ML project.' })
    expect(prompt).toContain('This is a Python ML project.')
  })

  it('detects Node.js project in CWD', () => {
    // Current project has package.json
    const prompt = buildSystemPrompt({ cwd: process.cwd() })
    expect(prompt).toContain('Node.js/TypeScript')
  })

  it('detects git repo in CWD', () => {
    const prompt = buildSystemPrompt({ cwd: process.cwd() })
    // Now shows branch name instead of just "yes"
    expect(prompt).toMatch(/Git: .+/)
  })
})

describe('mode flags in system prompt', () => {
  it('includes brief mode instruction when brief is true', () => {
    const prompt = buildSystemPrompt({ modes: { brief: true } })
    expect(prompt).toContain('BRIEF mode')
    expect(prompt).toContain('response_mode')
  })

  it('includes fast mode instruction when fast is true', () => {
    const prompt = buildSystemPrompt({ modes: { fast: true } })
    expect(prompt).toContain('FAST mode')
  })

  it('includes effort level when not medium', () => {
    const prompt = buildSystemPrompt({ modes: { effort: 'low' } })
    expect(prompt).toContain('Effort level: low')
  })

  it('omits mode section when no modes set', () => {
    const prompt = buildSystemPrompt({})
    expect(prompt).not.toContain('response_mode')
  })

  it('omits effort when medium (default)', () => {
    const prompt = buildSystemPrompt({ modes: { effort: 'medium' } })
    expect(prompt).not.toContain('Effort level')
  })
})

describe('project memory file loading', () => {
  const tmpDir = path.join(process.cwd(), '.test-memory-tmp')

  beforeEach(() => {
    const fs = require('node:fs')
    fs.mkdirSync(tmpDir, { recursive: true })
    // Create a fake .git so it acts as git root
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true })
  })

  afterEach(() => {
    const fs = require('node:fs')
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('loads OWLCODA.md into system prompt', () => {
    const fs = require('node:fs')
    fs.writeFileSync(path.join(tmpDir, 'OWLCODA.md'), '# OwlCoda Config\nCustom rules here')
    const prompt = buildSystemPrompt({ cwd: tmpDir })
    expect(prompt).toContain('project_instructions')
    expect(prompt).toContain('Custom rules here')
  })

  it('loads AGENTS.md and CLAUDE.md into system prompt before legacy OWLCODA.md', () => {
    const fs = require('node:fs')
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'Agents rules')
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), 'Claude rules')
    fs.writeFileSync(path.join(tmpDir, 'OWLCODA.md'), 'OwlCoda rules')

    const prompt = buildSystemPrompt({ cwd: tmpDir })

    expect(prompt).toContain('<project_instructions source="AGENTS.md">')
    expect(prompt).toContain('<project_instructions source="CLAUDE.md">')
    expect(prompt.indexOf('Agents rules')).toBeLessThan(prompt.indexOf('Claude rules'))
    expect(prompt.indexOf('Claude rules')).toBeLessThan(prompt.indexOf('OwlCoda rules'))
  })

  it('omits project_instructions when no memory files', () => {
    const prompt = buildSystemPrompt({ cwd: tmpDir })
    expect(prompt).not.toContain('project_instructions')
  })
})
