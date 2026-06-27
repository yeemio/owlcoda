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

  it('applies built-in preset default schema and policy when caller only passes preset', async () => {
    let executorRequest: Parameters<StructuredOutputExecutor>[0] | undefined
    const result = await runModelOutputHarness({
      model: 'kimi',
      preset: 'evidence-digest.v1',
      user: 'Digest this evidence.',
    }, async request => {
      executorRequest = request
      return {
        text: JSON.stringify({
          artifact: 'evidence-digest.v1',
          summary: 'Default contract digest.',
          confidence: 0.71,
        }),
        stopReason: 'end_turn',
      }
    })

    expect(result.ok).toBe(true)
    expect(executorRequest?.schema?.required).toEqual(expect.arrayContaining(['artifact', 'summary', 'confidence']))
    expect(executorRequest?.schema?.properties?.artifact).toMatchObject({ const: 'evidence-digest.v1' })
    expect(executorRequest?.policy).toMatchObject({
      maxArrayItems: 12,
      maxStringLength: 1200,
    })
    expect(executorRequest?.salvagePolicy?.fields).toEqual(expect.arrayContaining(['artifact', 'summary', 'confidence']))
    expect(executorRequest?.system).toContain('Return exactly one short JSON object')
  })

  it('uses the built-in preset schema to reject incomplete artifacts', async () => {
    const result = await runModelOutputHarness({
      model: 'kimi',
      preset: 'evidence-digest.v1',
      user: 'Digest this evidence.',
    }, executorReturning({
      text: '{"artifact":"evidence-digest.v1","summary":"Missing confidence"}',
      stopReason: 'end_turn',
    }))

    expect(result.ok).toBe(false)
    expect(result.schemaValid).toBe(false)
    expect(result.fallbackUsed).toBe(true)
    expect(result.validationErrors).toEqual(expect.arrayContaining(['$.confidence is required']))
    expect(result.artifact).toMatchObject({
      artifact: 'failed_fallback.v1',
      failureReason: 'schema_validation_failed',
    })
  })

  it('rejects structured output before executor call when model capability declares JSON unsupported', async () => {
    let called = false
    const result = await runModelOutputHarness({
      model: 'text-only-model',
      preset: 'evidence-digest.v1',
      user: 'Digest this evidence.',
      modelCapabilities: {
        jsonMode: { status: 'unsupported', source: 'declared', reason: 'provider only returns prose' },
        maxContextTokens: { tokens: 64_000, source: 'declared' },
        maxOutputTokens: { tokens: 2048, source: 'declared' },
        streaming: { status: 'supported', source: 'declared' },
        thinking: { behavior: 'unknown', source: 'fallback' },
      },
    }, async () => {
      called = true
      return { text: '{"artifact":"evidence-digest.v1","summary":"should not run","confidence":1}' }
    })

    expect(called).toBe(false)
    expect(result.ok).toBe(false)
    expect(result.fallbackUsed).toBe(true)
    expect(result.artifact).toMatchObject({
      artifact: 'failed_fallback.v1',
      failureReason: 'capability_json_unsupported',
      model: 'text-only-model',
    })
    expect(result.validationErrors).toEqual(expect.arrayContaining([
      'model capability jsonMode=unsupported source=declared',
    ]))
    expect(result.capabilityGate).toMatchObject({
      ok: false,
      source: 'declared',
      errors: ['model capability jsonMode=unsupported source=declared'],
    })
    expect(result.attempts.map(a => a.label)).toEqual(['fallback'])
  })

  it('caps structured output maxTokens to the model output capability without changing provider by name', async () => {
    let executorRequest: Parameters<StructuredOutputExecutor>[0] | undefined
    const result = await runModelOutputHarness({
      model: 'private-json-model',
      preset: 'evidence-digest.v1',
      user: 'Digest this evidence.',
      maxTokens: 1200,
      modelCapabilities: {
        jsonMode: { status: 'supported', source: 'manual' },
        maxContextTokens: { tokens: 128_000, source: 'manual' },
        maxOutputTokens: { tokens: 640, source: 'manual' },
        streaming: { status: 'unknown', source: 'fallback' },
        thinking: { behavior: 'text_and_thinking', source: 'manual' },
      },
    }, async request => {
      executorRequest = request
      return {
        text: JSON.stringify({
          artifact: 'evidence-digest.v1',
          summary: 'Capped digest.',
          confidence: 0.78,
        }),
        stopReason: 'end_turn',
      }
    })

    expect(result.ok).toBe(true)
    expect(executorRequest?.maxTokens).toBe(640)
    expect(result.capabilityGate).toMatchObject({
      ok: true,
      source: 'manual',
      appliedMaxTokens: 640,
      warnings: ['requested maxTokens 1200 capped to model maxOutputTokens 640'],
    })
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

  it('repairs fenced JSON with trailing commas and ignores text after the object', async () => {
    const result = await runModelOutputHarness(baseRequest, executorReturning({
      text: [
        '```json',
        '{',
        '  "artifact": "evidence-digest.v1",',
        '  "summary": "Fenced digest",',
        '  "confidence": 0.66,',
        '  "risks": ["weather",],',
        '}',
        '```',
        'Additional explanation that must not become artifact.',
      ].join('\n'),
      stopReason: 'end_turn',
    }))

    expect(result.ok).toBe(true)
    expect(result.repairCount).toBe(1)
    expect(result.artifact).toMatchObject({
      artifact: 'evidence-digest.v1',
      summary: 'Fenced digest',
      confidence: 0.66,
      risks: ['weather'],
    })
    expect(result.attempts.map(a => a.label)).toEqual(['primary', 'repair'])
  })

  it('salvages YAML-like bullet lists into array fields', async () => {
    const result = await runModelOutputHarness({
      ...baseRequest,
      salvagePolicy: { enabled: true, fields: ['artifact', 'summary', 'confidence', 'risks'] },
    }, executorReturning({
      text: [
        'artifact: evidence-digest.v1',
        'summary: Bullet list digest',
        'confidence: 0.58',
        'risks:',
        '- weather delay',
        '- lineup uncertainty',
        '{broken',
      ].join('\n'),
      stopReason: 'max_tokens',
    }))

    expect(result.ok).toBe(true)
    expect(result.salvageUsed).toBe(true)
    expect(result.parsed).toBe(false)
    expect(result.artifact).toMatchObject({
      artifact: 'evidence-digest.v1',
      summary: 'Bullet list digest',
      confidence: 0.58,
      risks: ['weather delay', 'lineup uncertainty'],
    })
    expect(result.attempts.map(a => a.label)).toEqual(['primary', 'salvage'])
  })

  it('salvages partial inline arrays into array fields', async () => {
    const result = await runModelOutputHarness({
      ...baseRequest,
      salvagePolicy: { enabled: true, fields: ['artifact', 'summary', 'confidence', 'risks'] },
    }, executorReturning({
      text: [
        'artifact: evidence-digest.v1',
        'summary: Partial array digest',
        'confidence: 0.6',
        'risks: ["weather delay", "lineup uncertainty"',
        '{broken',
      ].join('\n'),
      stopReason: 'max_tokens',
    }))

    expect(result.ok).toBe(true)
    expect(result.salvageUsed).toBe(true)
    expect(result.parsed).toBe(false)
    expect(result.artifact.risks).toEqual(['weather delay', 'lineup uncertainty'])
    expect(result.attempts.map(a => a.label)).toEqual(['primary', 'salvage'])
  })

  it('salvages single-quoted and Chinese-quoted scalar fields without marking parse success', async () => {
    const result = await runModelOutputHarness({
      ...baseRequest,
      salvagePolicy: { enabled: true, fields: ['artifact', 'summary', 'confidence'] },
    }, executorReturning({
      text: [
        "artifact: 'evidence-digest.v1'",
        'summary: “Quoted digest”',
        'confidence: 0.51',
        '{broken',
      ].join('\n'),
      stopReason: 'max_tokens',
    }))

    expect(result.ok).toBe(true)
    expect(result.salvageUsed).toBe(true)
    expect(result.parsed).toBe(false)
    expect(result.artifact).toMatchObject({
      artifact: 'evidence-digest.v1',
      summary: 'Quoted digest',
      confidence: 0.51,
    })
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

  it('can sanitize forbidden phrases into risks when policy requests it', async () => {
    const result = await runModelOutputHarness({
      ...baseRequest,
      policy: {
        forbiddenPhrases: ['建议买'],
        forbiddenPhraseAction: 'sanitize_to_risks',
      },
    }, executorReturning({
      text: '{"artifact":"evidence-digest.v1","summary":"建议买这个方向","confidence":0.9,"risks":[]}',
      stopReason: 'end_turn',
    }))

    expect(result.ok).toBe(true)
    expect(result.schemaValid).toBe(true)
    expect(result.validationErrors).toEqual([])
    expect(result.artifact.summary).toBe('[sanitized forbidden phrase]')
    expect(result.artifact.risks).toEqual(['sanitized forbidden phrase: 建议买'])
    expect(JSON.stringify(result.artifact)).not.toContain('建议买这个方向')
  })
})
