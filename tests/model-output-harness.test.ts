import { describe, it, expect } from 'vitest'
import {
  PROVIDER_PRESET_MATRIX,
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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
    expect(result.data).toBe(result.artifact)
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
    expect(result.data).toBe(result.artifact)
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

  it('does not cap explicit maxTokens with fallback model output capability', async () => {
    let executorRequest: Parameters<StructuredOutputExecutor>[0] | undefined
    const result = await runModelOutputHarness({
      model: 'kimi',
      preset: 'evidence-digest.v1',
      user: 'Digest this evidence.',
      maxTokens: 20_480,
      modelCapabilities: {
        jsonMode: { status: 'supported', source: 'manual' },
        maxContextTokens: { tokens: 128_000, source: 'manual' },
        maxOutputTokens: { tokens: 4096, source: 'fallback' },
        streaming: { status: 'unknown', source: 'fallback' },
        thinking: { behavior: 'unknown', source: 'fallback' },
      },
    }, async request => {
      executorRequest = request
      return {
        text: JSON.stringify({
          artifact: 'evidence-digest.v1',
          summary: 'Uncapped digest.',
          confidence: 0.83,
        }),
        stopReason: 'end_turn',
      }
    })

    expect(result.ok).toBe(true)
    expect(executorRequest?.maxTokens).toBe(20_480)
    expect(result.capabilityGate).toMatchObject({
      ok: true,
      requestedMaxTokens: 20_480,
      appliedMaxTokens: 20_480,
      modelCapabilities: {
        maxOutputTokens: { tokens: 4096, source: 'fallback' },
      },
    })
    expect(result.capabilityGate?.warnings).not.toEqual(expect.arrayContaining([
      'requested maxTokens 20480 capped to model maxOutputTokens 4096',
    ]))
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

  it('salvages a schema-valid artifact from provider thinking text when final text is empty', async () => {
    const result = await runModelOutputHarness(baseRequest, executorReturning({
      text: '',
      thinkingText: [
        'The provider placed the final object in a thinking block:',
        '```json',
        '{"artifact":"evidence-digest.v1","summary":"Thinking digest.","confidence":0.64}',
        '```',
      ].join('\n'),
      stopReason: 'max_tokens',
      inputTokens: 80,
      outputTokens: 256,
    }))

    expect(result.ok).toBe(true)
    expect(result.rawText).toBe('')
    expect(result.rawThinkingText).toContain('Thinking digest.')
    expect(result.salvageUsed).toBe(true)
    expect(result.fallbackUsed).toBe(false)
    expect(result.artifact).toMatchObject({
      artifact: 'evidence-digest.v1',
      summary: 'Thinking digest.',
      confidence: 0.64,
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

  it('keeps an active structured-output attempt alive when text deltas continue before idle timeout', async () => {
    const result = await runModelOutputHarness({
      ...baseRequest,
      idleTimeoutMs: 25,
      hardTimeoutMs: 250,
    }, async request => {
      const chunks = [
        '{"artifact":"evidence-digest.v1",',
        '"summary":"活跃输出摘要",',
        '"confidence":0.73}',
      ]
      for (const chunk of chunks) {
        await sleep(15)
        request.onOutputDelta?.({ type: 'text', text: chunk })
      }
      return {
        text: chunks.join(''),
        stopReason: 'end_turn',
        durationMs: 60,
      }
    })

    expect(result.ok).toBe(true)
    expect(result.terminationKind).toBe('completed')
    expect(result.consumerReady).toBe(true)
    expect(result.attempts[0]).toMatchObject({
      terminationKind: 'completed',
    })
    expect(result.attempts[0].lastOutputAt).toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('returns a failed fallback artifact with telemetry when no output arrives before idle timeout', async () => {
    const result = await runModelOutputHarness({
      ...baseRequest,
      idleTimeoutMs: 20,
      hardTimeoutMs: 250,
    }, async () => {
      await sleep(80)
      return {
        text: JSON.stringify({
          artifact: 'evidence-digest.v1',
          summary: 'too late',
          confidence: 0.5,
        }),
      }
    })

    expect(result.ok).toBe(false)
    expect(result.terminationKind).toBe('silent_timeout')
    expect(result.usable).toBe(false)
    expect(result.unusableReason).toBe('silent_timeout')
    expect(result.consumerReady).toBe(false)
    expect(result.consumerReadiness.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'silent_timeout' }),
    ]))
    expect(result.artifact).toMatchObject({
      artifact: 'failed_fallback.v1',
      ok: false,
      usable: false,
      unusableReason: 'silent_timeout',
      terminationKind: 'silent_timeout',
      rawText: '',
    })
    expect(result.artifact.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'fallback', terminationKind: 'silent_timeout' }),
    ]))
  })

  it('distinguishes hard timeout from silent timeout while preserving partial text', async () => {
    const result = await runModelOutputHarness({
      ...baseRequest,
      idleTimeoutMs: 100,
      hardTimeoutMs: 35,
    }, async request => {
      for (const chunk of ['{"artifact":"evidence-digest.v1",', '"summary":"still streaming",']) {
        await sleep(10)
        request.onOutputDelta?.({ type: 'text', text: chunk })
      }
      await sleep(80)
      return {
        text: '{"artifact":"evidence-digest.v1","summary":"too late","confidence":0.6}',
      }
    })

    expect(result.ok).toBe(false)
    expect(result.terminationKind).toBe('hard_timeout')
    expect(result.usable).toBe(false)
    expect(result.unusableReason).toBe('hard_timeout')
    expect(result.rawText).toContain('still streaming')
    expect(result.artifact).toMatchObject({
      artifact: 'failed_fallback.v1',
      terminationKind: 'hard_timeout',
    })
    expect(result.artifact.rawText).toContain('still streaming')
    expect(result.attempts[0]).toMatchObject({
      label: 'primary',
      terminationKind: 'hard_timeout',
    })
  })

  it('marks failed fallbacks as unusable and not consumer ready while preserving attempts and completeness', async () => {
    const result = await runModelOutputHarness(baseRequest, executorReturning({
      text: '',
      thinkingText: 'Long hidden reasoning without final JSON.',
      stopReason: 'max_tokens',
      inputTokens: 80,
      outputTokens: 1000,
    }))

    expect(result.ok).toBe(false)
    expect(result.usable).toBe(false)
    expect(result.unusableReason).toBe('empty_text_with_thinking')
    expect(result.consumerReady).toBe(false)
    expect(result.artifactCompleteness).toMatchObject({
      expected: ['artifact', 'summary', 'confidence'],
      produced: ['failed_fallback.v1'],
      missing: ['artifact', 'summary', 'confidence'],
      validationStatus: 'fail',
      fallbackStatus: 'failed_fallback',
    })
    expect(result.consumerReadiness.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'failed_fallback' }),
      expect.objectContaining({ code: 'missing_required_artifact' }),
    ]))
    expect(result.artifact).toMatchObject({
      artifact: 'failed_fallback.v1',
      usable: false,
      fallbackUsed: true,
      repairUsed: false,
      rawText: '',
      rawThinkingText: 'Long hidden reasoning without final JSON.',
    })
    expect(result.artifact.attempts).toEqual(result.attempts)
  })

  it('marks salvaged schema-valid output usable with salvage details and completeness receipt', async () => {
    const result = await runModelOutputHarness({
      ...baseRequest,
      salvagePolicy: { enabled: true, fields: ['artifact', 'summary', 'confidence'] },
    }, executorReturning({
      text: 'artifact: evidence-digest.v1\nsummary: Salvaged digest\nconfidence: 0.44\n{broken',
      stopReason: 'max_tokens',
    }))

    expect(result.ok).toBe(true)
    expect(result.usable).toBe(true)
    expect(result.consumerReady).toBe(true)
    expect(result.salvage).toMatchObject({
      used: true,
      fields: {
        artifact: 'evidence-digest.v1',
        summary: 'Salvaged digest',
        confidence: 0.44,
      },
      missingRequiredFields: [],
      confidence: 'medium',
    })
    expect(result.artifactCompleteness).toMatchObject({
      expected: ['artifact', 'summary', 'confidence'],
      produced: ['artifact', 'summary', 'confidence'],
      missing: [],
      validationStatus: 'pass',
      fallbackStatus: 'salvage',
    })
  })

  it('injects forceLocale into the prompt and blocks locale-mismatched artifacts as unusable', async () => {
    let executorRequest: Parameters<StructuredOutputExecutor>[0] | undefined
    const result = await runModelOutputHarness({
      ...baseRequest,
      forceLocale: 'zh-CN',
    }, async request => {
      executorRequest = request
      return {
        text: JSON.stringify({
          artifact: 'evidence-digest.v1',
          summary: 'English only digest',
          confidence: 0.81,
        }),
        stopReason: 'end_turn',
      }
    })

    expect(executorRequest?.system).toContain('zh-CN')
    expect(result.ok).toBe(false)
    expect(result.usable).toBe(false)
    expect(result.unusableReason).toBe('locale_mismatch')
    expect(result.consumerReady).toBe(false)
    expect(result.validationErrors).toEqual(expect.arrayContaining(['locale_mismatch:zh-CN']))
    expect(result.rawText).toContain('English only digest')
    expect(result.consumerReadiness.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'locale_mismatch' }),
    ]))
  })

  it('blocks mixed-language user-facing display fields when zh-CN locale is forced', async () => {
    const result = await runModelOutputHarness({
      ...baseRequest,
      forceLocale: 'zh-CN',
    }, executorReturning({
      text: JSON.stringify({
        artifact: 'evidence-digest.v1',
        summary: '中文摘要已经保留。',
        confidence: 0.81,
        risks: ['English risk should not pass locale gate'],
        source_refs: ['source:1'],
      }),
      stopReason: 'end_turn',
    }))

    expect(result.ok).toBe(false)
    expect(result.usable).toBe(false)
    expect(result.unusableReason).toBe('locale_mismatch')
    expect(result.consumerReady).toBe(false)
    expect(result.validationErrors).toEqual(expect.arrayContaining(['locale_mismatch:zh-CN:risks[0]']))
    expect(result.consumerReadiness.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'locale_mismatch' }),
    ]))
  })

  it('accepts zh-CN forced locale when user-facing fields contain Chinese text', async () => {
    const result = await runModelOutputHarness({
      ...baseRequest,
      force_locale: 'zh-CN',
    }, executorReturning({
      text: JSON.stringify({
        artifact: 'evidence-digest.v1',
        summary: '中文摘要已经保留。',
        confidence: 0.81,
      }),
      stopReason: 'end_turn',
    }))

    expect(result.ok).toBe(true)
    expect(result.usable).toBe(true)
    expect(result.consumerReady).toBe(true)
    expect(result.validationErrors).toEqual([])
  })

  it('exposes provider preset matrix and preset/schema versioning without provider-first preset names', async () => {
    expect(PROVIDER_PRESET_MATRIX.version).toBe('provider-preset-matrix.v1')
    expect(PROVIDER_PRESET_MATRIX.presets.map(item => item.presetId)).toEqual([
      'evidence-digest',
      'analyst-audit',
      'canonical-judge',
    ])
    expect(PROVIDER_PRESET_MATRIX.presets.some(item => /kimi|deepseek|gpt/i.test(item.presetId))).toBe(false)
    expect(PROVIDER_PRESET_MATRIX.presets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        presetId: 'evidence-digest',
        provider: 'kimi',
        idleTimeoutMs: expect.any(Number),
        hardTimeoutMs: expect.any(Number),
      }),
    ]))

    const result = await runModelOutputHarness(baseRequest, executorReturning({
      text: JSON.stringify({
        artifact: 'evidence-digest.v1',
        summary: 'Versioned digest.',
        confidence: 0.82,
      }),
      stopReason: 'end_turn',
    }))

    expect(result).toMatchObject({
      presetId: 'evidence-digest',
      presetVersion: 'v1',
      schemaId: 'evidence-digest',
      schemaVersion: 'v1',
      repairPolicyVersion: 'repair-policy.v1',
      providerMatrixVersion: 'provider-preset-matrix.v1',
    })
  })
})
