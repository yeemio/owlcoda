import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
    expect(prompt).toContain('# Output efficiency')
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

  it('omits project_instructions when no memory files', () => {
    const prompt = buildSystemPrompt({ cwd: tmpDir })
    expect(prompt).not.toContain('project_instructions')
  })
})
