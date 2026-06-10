import { describe, it, expect, vi } from 'vitest'
import {
  isWorthSynthesizing,
  synthesizeTemplate,
  buildLlmPrompt,
  parseLlmResponse,
  synthesize,
  synthesizeLlm,
} from '../src/skills/synthesizer.js'
import type { AnalyzedTrace, ToolCall, ErrorRecovery, WorkflowStep } from '../src/skills/trace-analyzer.js'
import { isValidSkillId } from '../src/skills/schema.js'

// ─── Fixtures ───

function makeTrace(overrides: Partial<AnalyzedTrace> = {}): AnalyzedTrace {
  return {
    sessionId: 'test-001',
    model: 'test-model',
    toolCalls: [],
    errorRecoveries: [],
    workflow: [],
    toolsUsed: [],
    complexity: 0,
    turnCount: 0,
    durationSec: 0,
    keywords: [],
    ...overrides,
  }
}

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return { index: 0, name: 'bash', input: {}, isError: false, timestamp: '', ...overrides }
}

const RICH_TRACE = makeTrace({
  toolCalls: [
    makeToolCall({ index: 0, name: 'file_read', input: { path: '.eslintrc.json' } }),
    makeToolCall({ index: 1, name: 'file_write', input: { path: '.eslintrc.json', content: '...' } }),
    makeToolCall({ index: 2, name: 'bash', input: { command: 'npx eslint --fix .' } }),
    makeToolCall({ index: 3, name: 'bash', input: { command: 'npm test' } }),
    makeToolCall({ index: 4, name: 'bash', input: { command: 'npm test' }, isError: true }),
    makeToolCall({ index: 5, name: 'file_read', input: { path: 'test.ts' } }),
    makeToolCall({ index: 6, name: 'bash', input: { command: 'npm test' } }),
  ],
  errorRecoveries: [{
    failedCall: makeToolCall({ name: 'bash', input: { command: 'npm test' }, isError: true }),
    recoveryCalls: [
      makeToolCall({ name: 'file_read' }),
      makeToolCall({ name: 'bash', input: { command: 'npm test' } }),
    ],
    recovered: true,
  }],
  workflow: [
    { order: 1, description: 'Read eslint config', tools: ['file_read'] },
    { order: 2, description: 'Update config', tools: ['file_write'] },
    { order: 3, description: 'Run eslint and tests', tools: ['bash'] },
  ],
  toolsUsed: ['file_read', 'file_write', 'bash'],
  complexity: 45,
  turnCount: 14,
  durationSec: 120,
  keywords: ['eslint', 'config', 'typescript', 'fix'],
})

// ─── Tests ───

describe('synthesizer', () => {
  describe('isWorthSynthesizing', () => {
    it('rejects empty traces', () => {
      const result = isWorthSynthesizing(makeTrace())
      expect(result.worth).toBe(false)
      expect(result.reason).toContain('Too few tool calls')
    })

    it('rejects low complexity', () => {
      const result = isWorthSynthesizing(makeTrace({
        toolCalls: [makeToolCall(), makeToolCall()],
        complexity: 5,
      }))
      expect(result.worth).toBe(false)
      expect(result.reason).toContain('Complexity too low')
    })

    it('rejects no workflow', () => {
      const result = isWorthSynthesizing(makeTrace({
        toolCalls: [makeToolCall(), makeToolCall()],
        complexity: 20,
        workflow: [],
      }))
      expect(result.worth).toBe(false)
      expect(result.reason).toContain('No workflow')
    })

    it('accepts rich traces', () => {
      expect(isWorthSynthesizing(RICH_TRACE).worth).toBe(true)
    })
  })

  describe('synthesizeTemplate', () => {
    it('produces a valid skill document', () => {
      const { skill, confidence, warnings } = synthesizeTemplate(RICH_TRACE)
      expect(isValidSkillId(skill.id)).toBe(true)
      expect(skill.name.length).toBeGreaterThan(0)
      expect(skill.description.length).toBeGreaterThan(0)
      expect(skill.procedure.length).toBe(3) // matches workflow steps
      expect(skill.synthesisMode).toBe('template')
      expect(skill.createdFrom).toBe('test-001')
      expect(confidence).toBeGreaterThan(0.3)
      expect(warnings).toEqual([])
    })

    it('warns on low-quality traces', () => {
      const { warnings } = synthesizeTemplate(makeTrace({
        toolCalls: [makeToolCall()],
        complexity: 2,
      }))
      expect(warnings.length).toBeGreaterThan(0)
    })

    it('respects name override', () => {
      const { skill } = synthesizeTemplate(RICH_TRACE, { mode: 'template', name: 'My Custom Skill' })
      expect(skill.name).toBe('My Custom Skill')
      expect(skill.id).toBe('my-custom-skill')
    })

    it('respects description override', () => {
      const { skill } = synthesizeTemplate(RICH_TRACE, { mode: 'template', description: 'Custom desc' })
      expect(skill.description).toBe('Custom desc')
    })

    it('includes extra tags', () => {
      const { skill } = synthesizeTemplate(RICH_TRACE, { mode: 'template', extraTags: ['custom-tag'] })
      expect(skill.tags).toContain('custom-tag')
    })

    it('builds pitfalls from error recoveries', () => {
      const { skill } = synthesizeTemplate(RICH_TRACE)
      expect(skill.pitfalls).toHaveLength(1)
      expect(skill.pitfalls[0].description).toContain('bash')
      expect(skill.pitfalls[0].mitigation).toContain('Recovery')
    })

    it('builds verification from last bash call', () => {
      const { skill } = synthesizeTemplate(RICH_TRACE)
      const bashVerification = skill.verification.find(v => v.check.includes('npm test'))
      expect(bashVerification).toBeDefined()
    })

    it('includes whenToUse with keywords', () => {
      const { skill } = synthesizeTemplate(RICH_TRACE)
      expect(skill.whenToUse).toContain('eslint')
    })

    it('sets useCount to 0', () => {
      const { skill } = synthesizeTemplate(RICH_TRACE)
      expect(skill.useCount).toBe(0)
    })

    it('generates higher confidence for richer traces', () => {
      const simple = synthesizeTemplate(makeTrace({
        toolCalls: [makeToolCall(), makeToolCall()],
        complexity: 15,
        workflow: [{ order: 1, description: 'step', tools: ['bash'] }],
      }))
      const rich = synthesizeTemplate(RICH_TRACE)
      expect(rich.confidence).toBeGreaterThan(simple.confidence)
    })
  })

  describe('buildLlmPrompt', () => {
    it('includes trace summary', () => {
      const prompt = buildLlmPrompt(RICH_TRACE)
      expect(prompt).toContain('test-model')
      expect(prompt).toContain('eslint')
      expect(prompt).toContain('Workflow Steps')
      expect(prompt).toContain('Error Recovery')
    })

    it('includes JSON schema', () => {
      const prompt = buildLlmPrompt(RICH_TRACE)
      expect(prompt).toContain('"name"')
      expect(prompt).toContain('"procedure"')
      expect(prompt).toContain('"pitfalls"')
    })

    it('skips error recovery section when none', () => {
      const prompt = buildLlmPrompt(makeTrace({ workflow: [{ order: 1, description: 'test', tools: ['bash'] }] }))
      expect(prompt).not.toContain('Error Recovery')
    })
  })

  describe('parseLlmResponse', () => {
    it('parses valid JSON response', () => {
      const json = JSON.stringify({
        name: 'Fix ESLint Config',
        description: 'Fix broken ESLint configurations',
        whenToUse: 'When ESLint config is broken',
        procedure: [{ order: 1, action: 'Read config', detail: 'Check .eslintrc' }],
        pitfalls: [{ description: 'Wrong parser', mitigation: 'Use @typescript-eslint/parser' }],
        verification: [{ check: 'Run eslint', expected: 'No errors' }],
        tags: ['eslint', 'config'],
      })
      const { skill, confidence, warnings } = parseLlmResponse(json, RICH_TRACE)
      expect(skill.name).toBe('Fix ESLint Config')
      expect(skill.procedure).toHaveLength(1)
      expect(skill.synthesisMode).toBe('llm')
      expect(confidence).toBe(0.8)
      expect(warnings).toEqual([])
    })

    it('handles markdown-fenced JSON', () => {
      const json = '```json\n{"name":"Test","description":"desc","procedure":[{"order":1,"action":"do"}],"tags":["x"]}\n```'
      const { skill } = parseLlmResponse(json, RICH_TRACE)
      expect(skill.name).toBe('Test')
    })

    it('falls back to template on invalid JSON', () => {
      const { skill, warnings } = parseLlmResponse('not json at all', RICH_TRACE)
      expect(skill.synthesisMode).toBe('template')
      expect(warnings.some(w => w.includes('Failed to parse'))).toBe(true)
    })

    it('handles partial response (no procedure)', () => {
      const json = JSON.stringify({ name: 'Partial', description: 'desc' })
      const { skill, warnings } = parseLlmResponse(json, RICH_TRACE)
      expect(skill.procedure).toEqual([])
      expect(warnings.some(w => w.includes('no procedure'))).toBe(true)
    })

    it('falls back to trace keywords when tags missing', () => {
      const json = JSON.stringify({ name: 'No Tags', description: 'desc', procedure: [{ action: 'x' }] })
      const { skill } = parseLlmResponse(json, RICH_TRACE)
      expect(skill.tags.length).toBeGreaterThan(0) // should use trace.keywords
    })
  })

  describe('synthesize (main entry)', () => {
    it('uses template mode by default', async () => {
      const result = await synthesize(RICH_TRACE, { mode: 'template' })
      expect(result.skill.synthesisMode).toBe('template')
    })

    it('falls back to template when LLM config missing', async () => {
      const result = await synthesize(RICH_TRACE, { mode: 'llm' })
      expect(result.skill.synthesisMode).toBe('template')
      expect(result.warnings.some(w => w.includes('fell back'))).toBe(true)
    })

    it('applies overrides in LLM mode fallback', async () => {
      const result = await synthesize(RICH_TRACE, {
        mode: 'llm',
        name: 'Override Name',
        description: 'Override desc',
        extraTags: ['extra'],
      })
      // Falls back to template since no endpoint
      expect(result.skill.synthesisMode).toBe('template')
      expect(result.warnings.some(w => w.includes('fell back'))).toBe(true)
    })
  })

  describe('synthesizeLlm diagnostics', () => {
    it('formats upstream HTTP failures with provider diagnostics', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'bad gateway' } }), {
        status: 502,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'llm-upstream-502',
        },
      }))
      vi.stubGlobal('fetch', fetchMock)

      try {
        const result = await synthesizeLlm(RICH_TRACE, 'https://api.openai.com', 'gpt-4.1')
        expect(result.skill.synthesisMode).toBe('template')
        expect(result.warnings[0]).toContain('upstream 502 from provider')
        expect(result.warnings[0]).toContain('llm-upstream-502')
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('formats transport failures with provider diagnostics', async () => {
      const err = new Error('getaddrinfo ENOTFOUND api.openai.com')
      Object.assign(err, { code: 'ENOTFOUND', syscall: 'getaddrinfo' })
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err))

      try {
        const result = await synthesizeLlm(RICH_TRACE, 'https://api.openai.com', 'gpt-4.1')
        expect(result.skill.synthesisMode).toBe('template')
        expect(result.warnings[0]).toContain('DNS lookup failed')
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })
})
