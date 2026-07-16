import { describe, expect, it } from 'vitest'
import {
  MODEL_OUTPUT_PROVIDER_MATRIX_FIXTURES,
  formatModelOutputProviderMatrixReport,
  runModelOutputProviderMatrix,
} from '../src/model-output-provider-matrix.js'

const providerClasses = [
  'kimi-long-context-thinking',
  'deepseek-analyst',
  'gpt-canonical-judge',
  'local-qwen-mlx',
]

const outcomes = [
  'parse_success',
  'repair_success',
  'salvage_success',
  'failed_fallback',
  'policy_violation',
]

const providerAgnosticPresets = [
  'evidence-digest.v1',
  'analyst-audit.v1',
  'canonical-judge.v1',
]

describe('model output provider matrix', () => {
  it('defines fixed local samples for every provider class and outcome', () => {
    expect(MODEL_OUTPUT_PROVIDER_MATRIX_FIXTURES).toHaveLength(20)

    for (const providerClass of providerClasses) {
      const samples = MODEL_OUTPUT_PROVIDER_MATRIX_FIXTURES.filter(
        sample => sample.providerClass === providerClass,
      )
      expect(samples, providerClass).toHaveLength(5)
      expect(samples.map(sample => sample.expectedOutcome).sort()).toEqual([...outcomes].sort())
    }

    expect(new Set(MODEL_OUTPUT_PROVIDER_MATRIX_FIXTURES.map(sample => sample.sampleId)).size).toBe(
      MODEL_OUTPUT_PROVIDER_MATRIX_FIXTURES.length,
    )
    expect(MODEL_OUTPUT_PROVIDER_MATRIX_FIXTURES.every(sample => sample.localOnly)).toBe(true)
    expect(MODEL_OUTPUT_PROVIDER_MATRIX_FIXTURES.every(sample => sample.trainingUse === 'not_collected')).toBe(true)
    expect(MODEL_OUTPUT_PROVIDER_MATRIX_FIXTURES.every(sample => providerAgnosticPresets.includes(sample.preset))).toBe(true)
  })

  it('runs the local matrix through the model output harness and reports actual outcomes', async () => {
    const report = await runModelOutputProviderMatrix()

    expect(report).toMatchObject({
      schemaVersion: 1,
      source: 'local_fixture_provider_matrix',
      localOnly: true,
      trainingUse: 'not_collected',
      providerClassCount: 4,
      sampleCount: 20,
      mismatches: [],
    })
    expect(report.providerClasses.map(provider => provider.providerClass)).toEqual(providerClasses)
    for (const provider of report.providerClasses) {
      expect(provider.sampleCount).toBe(5)
      expect(provider.expectedOutcomes.sort()).toEqual([...outcomes].sort())
      expect(provider.suitedPresets.every(preset => providerAgnosticPresets.includes(preset))).toBe(true)
    }
    expect(report.outcomeCounts).toEqual({
      parse_success: 4,
      repair_success: 4,
      salvage_success: 4,
      failed_fallback: 4,
      policy_violation: 4,
    })
    expect(report.samples).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sampleId: 'kimi-json-after-explanation',
        expectedOutcome: 'parse_success',
        actualOutcome: 'parse_success',
        ok: true,
      }),
      expect.objectContaining({
        sampleId: 'kimi-max-tokens-repair',
        expectedOutcome: 'repair_success',
        actualOutcome: 'repair_success',
        ok: true,
      }),
      expect.objectContaining({
        sampleId: 'kimi-long-reasoning-salvage',
        expectedOutcome: 'salvage_success',
        actualOutcome: 'salvage_success',
        ok: true,
      }),
      expect.objectContaining({
        providerClass: 'kimi-long-context-thinking',
        sampleId: 'kimi-thinking-only-fallback',
        expectedOutcome: 'failed_fallback',
        actualOutcome: 'failed_fallback',
        fallbackUsed: true,
      }),
      expect.objectContaining({
        providerClass: 'deepseek-analyst',
        sampleId: 'deepseek-prose-wrapped-json',
        expectedOutcome: 'parse_success',
        actualOutcome: 'parse_success',
        ok: true,
      }),
      expect.objectContaining({
        providerClass: 'gpt-canonical-judge',
        sampleId: 'gpt-schema-strict-policy',
        expectedOutcome: 'policy_violation',
        actualOutcome: 'policy_violation',
        fallbackUsed: true,
      }),
      expect.objectContaining({
        providerClass: 'local-qwen-mlx',
        sampleId: 'local-qwen-missing-fields-fallback',
        expectedOutcome: 'failed_fallback',
        actualOutcome: 'failed_fallback',
        fallbackUsed: true,
      }),
    ]))
    expect(report.failedFixtureSampleIds).toEqual(expect.arrayContaining([
      'kimi-thinking-only-fallback',
      'gpt-schema-strict-policy',
      'local-qwen-missing-fields-fallback',
    ]))
  })

  it('formats a decision-ready provider matrix report without turning samples into training data', async () => {
    const markdown = formatModelOutputProviderMatrixReport(await runModelOutputProviderMatrix())

    expect(markdown).toContain('# Model Output Provider Matrix')
    expect(markdown).toContain('source: local_fixture_provider_matrix')
    expect(markdown).toContain('training_use: not_collected')
    expect(markdown).toContain('failed samples stay in local fixtures')
    expect(markdown).toContain('kimi-long-context-thinking')
    expect(markdown).toContain('deepseek-analyst')
    expect(markdown).toContain('gpt-canonical-judge')
    expect(markdown).toContain('local-qwen-mlx')
    expect(markdown).toContain('evidence-digest.v1')
    expect(markdown).toContain('analyst-audit.v1')
    expect(markdown).toContain('canonical-judge.v1')
    expect(markdown).not.toMatch(/kimi-evidence-digest|deepseek-analyst-audit|gpt-judge-canonical/u)
  })
})
