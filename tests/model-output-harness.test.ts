import { describe, it, expect } from 'vitest'
import {
  STRUCTURED_OUTPUT_PRESETS,
  runModelOutputHarness,
  type StructuredOutputExecutor,
  type StructuredOutputRequest,
} from '../src/model-output-harness.js'

const digestSchema: StructuredOutputRequest['schema'] = {
  type: 'object',
  required: ['artifact', 'summary', 'confidence'],
  properties: {
    artifact: { const: 'evidence-digest.v1' },
    summary: { type: 'string' },
    confidence: { type: 'number' },
    source_refs: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
}

function executorReturning(response: Awaited<ReturnType<StructuredOutputExecutor>>): StructuredOutputExecutor {
  return async () => response
}

const baseRequest: StructuredOutputRequest = {
  model: 'kimi',
  preset: 'evidence-digest.v1',
  schema: digestSchema,
  user: 'Digest this evidence.',
  maxTokens: 1000,
}

describe('model output harness', () => {
  it('uses provider-agnostic preset names', () => {
    expect(Object.keys(STRUCTURED_OUTPUT_PRESETS)).toEqual([
      'evidence-digest.v1',
      'analyst-audit.v1',
      'canonical-judge.v1',
    ])
    expect(Object.keys(STRUCTURED_OUTPUT_PRESETS).some(name => /kimi|deepseek|gpt/i.test(name))).toBe(false)
  })

  it('parses complete JSON into a schema-valid artifact', async () => {
    const result = await runModelOutputHarness(baseRequest, executorReturning({
      text: JSON.stringify({
        artifact: 'evidence-digest.v1',
        summary: 'Short digest.',
        confidence: 0.82,
        source_refs: ['source:1'],
        risks: [],
      }),
      stopReason: 'end_turn',
      inputTokens: 20,
      outputTokens: 30,
      durationMs: 15,
    }))

    expect(result.ok).toBe(true)
    expect(result.parsed).toBe(true)
    expect(result.schemaValid).toBe(true)
    expect(result.fallbackUsed).toBe(false)
    expect(result.artifact.summary).toBe('Short digest.')
    expect(result.attempts.map(a => a.label)).toEqual(['primary', 'parse'])
  })

  it('extracts the first JSON object when the model wraps it in prose', async () => {
    const result = await runModelOutputHarness(baseRequest, executorReturning({
      text: [
        'Here is the artifact:',
        '{"artifact":"evidence-digest.v1","summary":"Wrapped digest.","confidence":0.7}',
        'Done.',
      ].join('\n'),
      stopReason: 'end_turn',
    }))

    expect(result.ok).toBe(true)
    expect(result.artifact.summary).toBe('Wrapped digest.')
    expect(result.attempts.map(a => a.label)).toEqual(['primary', 'parse'])
  })

  it('repairs max_tokens truncation when partial JSON can be closed', async () => {
    const result = await runModelOutputHarness(baseRequest, executorReturning({
      text: '{"artifact":"evidence-digest.v1","summary":"Truncated digest","confidence":0.62,"risks":["weather"',
      stopReason: 'max_tokens',
      outputTokens: 1000,
    }))

    expect(result.ok).toBe(true)
    expect(result.parsed).toBe(true)
    expect(result.schemaValid).toBe(true)
    expect(result.repairCount).toBe(1)
    expect(result.artifact.risks).toEqual(['weather'])
    expect(result.attempts.map(a => a.label)).toEqual(['primary', 'repair'])
  })

  it('salvages configured fields when repair cannot produce valid JSON', async () => {
    const result = await runModelOutputHarness({
      ...baseRequest,
      salvagePolicy: { enabled: true, fields: ['artifact', 'summary', 'confidence'] },
    }, executorReturning({
      text: 'artifact: evidence-digest.v1\nsummary: Salvaged digest\nconfidence: 0.44\n{broken',
      stopReason: 'max_tokens',
    }))

    expect(result.ok).toBe(true)
    expect(result.schemaValid).toBe(true)
    expect(result.salvageUsed).toBe(true)
    expect(result.artifact).toMatchObject({
      artifact: 'evidence-digest.v1',
      summary: 'Salvaged digest',
      confidence: 0.44,
    })
    expect(result.attempts.map(a => a.label)).toEqual(['primary', 'salvage'])
  })

  it('returns a structured failed fallback for empty text with thinking only', async () => {
    const result = await runModelOutputHarness(baseRequest, executorReturning({
      text: '',
      thinkingText: 'Long hidden reasoning without final JSON.',
      stopReason: 'max_tokens',
      inputTokens: 80,
      outputTokens: 1000,
    }))

    expect(result.ok).toBe(false)
    expect(result.fallbackUsed).toBe(true)
    expect(result.rawText).toBe('')
    expect(result.artifact).toMatchObject({
      artifact: 'failed_fallback.v1',
      ok: false,
      failureReason: 'empty_text_with_thinking',
      model: 'kimi',
      preset: 'evidence-digest.v1',
      retryHint: 'rerun_role_artifact',
    })
    expect(JSON.stringify(result.artifact)).not.toBe('{}')
    expect(result.attempts.map(a => a.label)).toEqual(['primary', 'fallback'])
  })

  it('blocks forbidden phrases so business callers cannot consume them as valid artifacts', async () => {
    const result = await runModelOutputHarness({
      ...baseRequest,
      policy: { forbiddenPhrases: ['建议买', '入串', 'EV', 'Kelly'] },
    }, executorReturning({
      text: '{"artifact":"evidence-digest.v1","summary":"建议买这个方向","confidence":0.9}',
      stopReason: 'end_turn',
    }))

    expect(result.ok).toBe(false)
    expect(result.schemaValid).toBe(false)
    expect(result.fallbackUsed).toBe(true)
    expect(result.validationErrors.some(e => e.includes('forbidden_phrase'))).toBe(true)
    expect(result.artifact).toMatchObject({
      artifact: 'failed_fallback.v1',
      failureReason: 'policy_violation',
    })
    expect(result.attempts.map(a => a.label)).toEqual(['primary', 'parse', 'fallback'])
  })
})
