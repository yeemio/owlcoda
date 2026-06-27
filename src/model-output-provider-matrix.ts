import {
  runModelOutputHarness,
  type BuiltinStructuredOutputPreset,
  type StructuredOutputAttempt,
  type StructuredOutputExecutor,
  type StructuredOutputModelResponse,
  type StructuredOutputPolicy,
  type StructuredOutputResponse,
  type StructuredOutputSalvagePolicy,
} from './model-output-harness.js'

export type ModelOutputProviderClass =
  | 'kimi-long-context-thinking'
  | 'deepseek-analyst'
  | 'gpt-canonical-judge'
  | 'local-qwen-mlx'

export type ModelOutputProviderMatrixOutcome =
  | 'parse_success'
  | 'repair_success'
  | 'salvage_success'
  | 'failed_fallback'
  | 'policy_violation'

export type ModelOutputProviderMatrixTrainingUse = 'not_collected'

export interface ModelOutputProviderMatrixFixture {
  sampleId: string
  providerClass: ModelOutputProviderClass
  title: string
  preset: BuiltinStructuredOutputPreset
  expectedOutcome: ModelOutputProviderMatrixOutcome
  user: string
  rawText: string
  rawThinkingText?: string
  stopReason: string | null
  inputTokens?: number
  outputTokens?: number
  durationMs?: number
  policy?: StructuredOutputPolicy
  salvagePolicy?: StructuredOutputSalvagePolicy
  maxTokens?: number
  localOnly: true
  trainingUse: ModelOutputProviderMatrixTrainingUse
}

export interface ModelOutputProviderMatrixClassReport {
  providerClass: ModelOutputProviderClass
  sampleCount: number
  expectedOutcomes: ModelOutputProviderMatrixOutcome[]
  suitedPresets: BuiltinStructuredOutputPreset[]
  notes: string[]
}

export interface ModelOutputProviderMatrixSampleReport {
  sampleId: string
  providerClass: ModelOutputProviderClass
  title: string
  preset: BuiltinStructuredOutputPreset
  expectedOutcome: ModelOutputProviderMatrixOutcome
  actualOutcome: ModelOutputProviderMatrixOutcome
  ok: boolean
  parsed: boolean
  schemaValid: boolean
  repairCount: number
  salvageUsed: boolean
  fallbackUsed: boolean
  stopReason: string | null
  validationErrors: string[]
  attempts: StructuredOutputAttempt[]
  rawTextArchived: boolean
  rawThinkingArchived: boolean
  trainingUse: ModelOutputProviderMatrixTrainingUse
}

export interface ModelOutputProviderMatrixMismatch {
  sampleId: string
  providerClass: ModelOutputProviderClass
  expectedOutcome: ModelOutputProviderMatrixOutcome
  actualOutcome: ModelOutputProviderMatrixOutcome
}

export interface ModelOutputProviderMatrixReport {
  schemaVersion: 1
  source: 'local_fixture_provider_matrix'
  localOnly: true
  trainingUse: ModelOutputProviderMatrixTrainingUse
  providerClassCount: number
  sampleCount: number
  providerClasses: ModelOutputProviderMatrixClassReport[]
  outcomeCounts: Record<ModelOutputProviderMatrixOutcome, number>
  failedFixtureSampleIds: string[]
  samples: ModelOutputProviderMatrixSampleReport[]
  mismatches: ModelOutputProviderMatrixMismatch[]
}

const PROVIDER_CLASS_ORDER: ModelOutputProviderClass[] = [
  'kimi-long-context-thinking',
  'deepseek-analyst',
  'gpt-canonical-judge',
  'local-qwen-mlx',
]

const OUTCOME_ORDER: ModelOutputProviderMatrixOutcome[] = [
  'parse_success',
  'repair_success',
  'salvage_success',
  'failed_fallback',
  'policy_violation',
]

const PROVIDER_CLASS_PRESETS: Record<ModelOutputProviderClass, BuiltinStructuredOutputPreset[]> = {
  'kimi-long-context-thinking': ['evidence-digest.v1'],
  'deepseek-analyst': ['analyst-audit.v1'],
  'gpt-canonical-judge': ['canonical-judge.v1'],
  'local-qwen-mlx': ['evidence-digest.v1', 'analyst-audit.v1'],
}

const PROVIDER_CLASS_NOTES: Record<ModelOutputProviderClass, string[]> = {
  'kimi-long-context-thinking': [
    'Best suited to evidence compression when long reasoning is suppressed and max_tokens truncation is recoverable.',
    'Thinking-only responses must produce failed_fallback.v1, not empty artifacts.',
  ],
  'deepseek-analyst': [
    'Best suited to fast analyst-audit passes over existing evidence artifacts.',
    'Should consume compact artifacts instead of rereading long evidence.',
  ],
  'gpt-canonical-judge': [
    'Best suited to strict canonical judge JSON after evidence and debate compression.',
    'Schema and policy failures should block consumption as final artifacts.',
  ],
  'local-qwen-mlx': [
    'Best suited to local low-cost passes when weak JSON and truncation are expected.',
    'Use repair/salvage aggressively and treat missing required fields as failed fallback.',
  ],
}

const LOCAL_FIXTURE = {
  localOnly: true,
  trainingUse: 'not_collected',
} as const

export const MODEL_OUTPUT_PROVIDER_MATRIX_FIXTURES: ModelOutputProviderMatrixFixture[] = [
  {
    ...LOCAL_FIXTURE,
    sampleId: 'kimi-json-after-explanation',
    providerClass: 'kimi-long-context-thinking',
    title: 'complete evidence JSON followed by explanation',
    preset: 'evidence-digest.v1',
    expectedOutcome: 'parse_success',
    user: 'Digest evidence into one artifact.',
    rawText: [
      '{"artifact":"evidence-digest.v1","summary":"Concise injury and source digest.","confidence":0.74,"source_refs":["kimi:source:1"],"risks":[]}',
      'Additional explanation after JSON should not enter the artifact.',
    ].join('\n'),
    stopReason: 'end_turn',
    inputTokens: 180,
    outputTokens: 96,
  },
  {
    ...LOCAL_FIXTURE,
    sampleId: 'kimi-max-tokens-repair',
    providerClass: 'kimi-long-context-thinking',
    title: 'max_tokens truncation with closable JSON',
    preset: 'evidence-digest.v1',
    expectedOutcome: 'repair_success',
    user: 'Digest long evidence into one artifact.',
    rawText: '{"artifact":"evidence-digest.v1","summary":"Truncated long evidence digest","confidence":0.63,"risks":["source conflict"',
    stopReason: 'max_tokens',
    inputTokens: 940,
    outputTokens: 1200,
  },
  {
    ...LOCAL_FIXTURE,
    sampleId: 'kimi-long-reasoning-salvage',
    providerClass: 'kimi-long-context-thinking',
    title: 'long prose before YAML-like recoverable fields',
    preset: 'evidence-digest.v1',
    expectedOutcome: 'salvage_success',
    user: 'Digest evidence without long reasoning.',
    rawText: [
      'I reviewed several sources and will only keep the artifact fields.',
      'artifact: evidence-digest.v1',
      'summary: Salvaged evidence digest',
      'confidence: 0.57',
      'risks:',
      '- stale source',
      '- partial market coverage',
      '{broken',
    ].join('\n'),
    stopReason: 'max_tokens',
  },
  {
    ...LOCAL_FIXTURE,
    sampleId: 'kimi-thinking-only-fallback',
    providerClass: 'kimi-long-context-thinking',
    title: 'thinking-only response with no final text',
    preset: 'evidence-digest.v1',
    expectedOutcome: 'failed_fallback',
    user: 'Digest evidence into one artifact.',
    rawText: '',
    rawThinkingText: 'Hidden reasoning consumed the output budget and no final JSON text was emitted.',
    stopReason: 'max_tokens',
    inputTokens: 840,
    outputTokens: 1200,
  },
  {
    ...LOCAL_FIXTURE,
    sampleId: 'kimi-business-language-policy',
    providerClass: 'kimi-long-context-thinking',
    title: 'business execution language inside evidence artifact',
    preset: 'evidence-digest.v1',
    expectedOutcome: 'policy_violation',
    user: 'Digest evidence without business execution language.',
    rawText: '{"artifact":"evidence-digest.v1","summary":"建议买这个方向，EV 和 Kelly 都支持。","confidence":0.91}',
    stopReason: 'end_turn',
    policy: { forbiddenPhrases: ['建议买', '入串', 'EV', 'Kelly'] },
  },
  {
    ...LOCAL_FIXTURE,
    sampleId: 'deepseek-prose-wrapped-json',
    providerClass: 'deepseek-analyst',
    title: 'fast analyst prose wrapping valid JSON',
    preset: 'analyst-audit.v1',
    expectedOutcome: 'parse_success',
    user: 'Audit the evidence artifact only.',
    rawText: [
      'Quick audit follows.',
      '{"artifact":"analyst-audit.v1","candidate_findings":["lineup uncertainty"],"conflicts":[],"gaps":["market depth"],"assumptions":["artifact is current"],"confidence":0.7}',
      'Audit artifact complete.',
    ].join('\n'),
    stopReason: 'end_turn',
  },
  {
    ...LOCAL_FIXTURE,
    sampleId: 'deepseek-self-audit-truncated-array',
    providerClass: 'deepseek-analyst',
    title: 'self-audit JSON truncated inside array',
    preset: 'analyst-audit.v1',
    expectedOutcome: 'repair_success',
    user: 'Audit compact evidence.',
    rawText: '{"artifact":"analyst-audit.v1","candidate_findings":["tempo edge"],"conflicts":[],"gaps":["odds gap"],"assumptions":["baseline unchanged"],"confidence":0.62',
    stopReason: 'max_tokens',
    outputTokens: 860,
  },
  {
    ...LOCAL_FIXTURE,
    sampleId: 'deepseek-yaml-audit-salvage',
    providerClass: 'deepseek-analyst',
    title: 'YAML-like analyst audit fields',
    preset: 'analyst-audit.v1',
    expectedOutcome: 'salvage_success',
    user: 'Audit compact evidence.',
    rawText: [
      'artifact: analyst-audit.v1',
      'candidate_findings:',
      '- schedule fatigue',
      'conflicts:',
      '- source A vs source B',
      'gaps:',
      '- no live market',
      'assumptions:',
      '- compact evidence is current',
      'confidence: 0.61',
      '{broken',
    ].join('\n'),
    stopReason: 'max_tokens',
  },
  {
    ...LOCAL_FIXTURE,
    sampleId: 'deepseek-missing-confidence-fallback',
    providerClass: 'deepseek-analyst',
    title: 'schema missing confidence',
    preset: 'analyst-audit.v1',
    expectedOutcome: 'failed_fallback',
    user: 'Audit compact evidence.',
    rawText: '{"artifact":"analyst-audit.v1","candidate_findings":[],"conflicts":[],"gaps":[],"assumptions":[]}',
    stopReason: 'end_turn',
  },
  {
    ...LOCAL_FIXTURE,
    sampleId: 'deepseek-final-judgment-policy',
    providerClass: 'deepseek-analyst',
    title: 'analyst tries to make a final judgment',
    preset: 'analyst-audit.v1',
    expectedOutcome: 'policy_violation',
    user: 'Audit compact evidence without final judgment.',
    rawText: '{"artifact":"analyst-audit.v1","candidate_findings":["final judgment: approve direction"],"conflicts":[],"gaps":[],"assumptions":[],"confidence":0.8}',
    stopReason: 'end_turn',
  },
  {
    ...LOCAL_FIXTURE,
    sampleId: 'gpt-canonical-json',
    providerClass: 'gpt-canonical-judge',
    title: 'strict canonical judge JSON',
    preset: 'canonical-judge.v1',
    expectedOutcome: 'parse_success',
    user: 'Return canonical judge JSON.',
    rawText: '{"artifact":"canonical-judge.v1","decision":"watch","confidence":0.69,"rationale_summary":"Compressed evidence is mixed.","evidence_refs":["evidence:1"],"conflicts":[]}',
    stopReason: 'end_turn',
  },
  {
    ...LOCAL_FIXTURE,
    sampleId: 'gpt-canonical-trailing-comma-repair',
    providerClass: 'gpt-canonical-judge',
    title: 'canonical JSON fenced with trailing commas',
    preset: 'canonical-judge.v1',
    expectedOutcome: 'repair_success',
    user: 'Return canonical judge JSON.',
    rawText: [
      '```json',
      '{',
      '  "artifact": "canonical-judge.v1",',
      '  "decision": "watch",',
      '  "confidence": 0.64,',
      '  "evidence_refs": ["compressed:1",],',
      '  "conflicts": [],',
      '}',
      '```',
    ].join('\n'),
    stopReason: 'end_turn',
  },
  {
    ...LOCAL_FIXTURE,
    sampleId: 'gpt-canonical-bullets-salvage',
    providerClass: 'gpt-canonical-judge',
    title: 'canonical fields emitted as bullet lists',
    preset: 'canonical-judge.v1',
    expectedOutcome: 'salvage_success',
    user: 'Return canonical judge JSON.',
    rawText: [
      'artifact: canonical-judge.v1',
      'decision: watch',
      'confidence: 0.59',
      'rationale_summary: Salvaged canonical summary',
      'evidence_refs:',
      '- compressed:1',
      'conflicts:',
      '- market conflict',
      '{broken',
    ].join('\n'),
    stopReason: 'max_tokens',
  },
  {
    ...LOCAL_FIXTURE,
    sampleId: 'gpt-canonical-missing-decision-fallback',
    providerClass: 'gpt-canonical-judge',
    title: 'canonical artifact missing required decision',
    preset: 'canonical-judge.v1',
    expectedOutcome: 'failed_fallback',
    user: 'Return canonical judge JSON.',
    rawText: '{"artifact":"canonical-judge.v1","confidence":0.55,"evidence_refs":[],"conflicts":[]}',
    stopReason: 'end_turn',
  },
  {
    ...LOCAL_FIXTURE,
    sampleId: 'gpt-schema-strict-policy',
    providerClass: 'gpt-canonical-judge',
    title: 'canonical artifact leaks chain-of-thought marker',
    preset: 'canonical-judge.v1',
    expectedOutcome: 'policy_violation',
    user: 'Return canonical judge JSON without hidden reasoning.',
    rawText: '{"artifact":"canonical-judge.v1","decision":"watch","confidence":0.72,"rationale_summary":"chain-of-thought says yes","evidence_refs":["compressed:1"],"conflicts":[]}',
    stopReason: 'end_turn',
  },
  {
    ...LOCAL_FIXTURE,
    sampleId: 'local-qwen-weak-json-extracted',
    providerClass: 'local-qwen-mlx',
    title: 'weak local prose around valid JSON',
    preset: 'evidence-digest.v1',
    expectedOutcome: 'parse_success',
    user: 'Digest evidence locally.',
    rawText: 'ok -> {"artifact":"evidence-digest.v1","summary":"Local model digest.","confidence":0.52,"risks":[]} <- done',
    stopReason: 'end_turn',
  },
  {
    ...LOCAL_FIXTURE,
    sampleId: 'local-qwen-truncated-repair',
    providerClass: 'local-qwen-mlx',
    title: 'local model truncates evidence digest',
    preset: 'evidence-digest.v1',
    expectedOutcome: 'repair_success',
    user: 'Digest evidence locally.',
    rawText: '{"artifact":"evidence-digest.v1","summary":"Local truncated digest","confidence":0.49,"data_gaps":["missing source"',
    stopReason: 'max_tokens',
    outputTokens: 384,
  },
  {
    ...LOCAL_FIXTURE,
    sampleId: 'local-mlx-yaml-salvage',
    providerClass: 'local-qwen-mlx',
    title: 'local MLX model emits YAML-like audit',
    preset: 'analyst-audit.v1',
    expectedOutcome: 'salvage_success',
    user: 'Audit compact artifact locally.',
    rawText: [
      'artifact: analyst-audit.v1',
      'candidate_findings:',
      '- weak local candidate',
      'conflicts:',
      '- incomplete odds',
      'gaps:',
      '- missing source refs',
      'assumptions:',
      '- local context is short',
      'confidence: 0.42',
      '{broken',
    ].join('\n'),
    stopReason: 'max_tokens',
  },
  {
    ...LOCAL_FIXTURE,
    sampleId: 'local-qwen-missing-fields-fallback',
    providerClass: 'local-qwen-mlx',
    title: 'local model drops required confidence',
    preset: 'evidence-digest.v1',
    expectedOutcome: 'failed_fallback',
    user: 'Digest evidence locally.',
    rawText: '{"artifact":"evidence-digest.v1","summary":"Missing required confidence"}',
    stopReason: 'end_turn',
  },
  {
    ...LOCAL_FIXTURE,
    sampleId: 'local-mlx-business-language-policy',
    providerClass: 'local-qwen-mlx',
    title: 'local model emits business execution language',
    preset: 'evidence-digest.v1',
    expectedOutcome: 'policy_violation',
    user: 'Digest evidence locally without business execution language.',
    rawText: '{"artifact":"evidence-digest.v1","summary":"Kelly says enter the ticket","confidence":0.66}',
    stopReason: 'end_turn',
    policy: { forbiddenPhrases: ['Kelly', 'enter the ticket', '建议买', 'EV'] },
  },
]

function executorForFixture(fixture: ModelOutputProviderMatrixFixture): StructuredOutputExecutor {
  return async (): Promise<StructuredOutputModelResponse> => ({
    text: fixture.rawText,
    ...(fixture.rawThinkingText ? { thinkingText: fixture.rawThinkingText } : {}),
    stopReason: fixture.stopReason,
    inputTokens: fixture.inputTokens ?? 0,
    outputTokens: fixture.outputTokens ?? 0,
    durationMs: fixture.durationMs ?? 0,
  })
}

function artifactFailureReason(result: StructuredOutputResponse): string | undefined {
  const reason = result.artifact.failureReason
  return typeof reason === 'string' ? reason : undefined
}

export function classifyModelOutputProviderMatrixOutcome(
  result: StructuredOutputResponse,
): ModelOutputProviderMatrixOutcome {
  if (
    artifactFailureReason(result) === 'policy_violation'
    || result.validationErrors.some(error => error.startsWith('forbidden_phrase:'))
  ) {
    return 'policy_violation'
  }
  if (result.fallbackUsed || !result.ok) return 'failed_fallback'
  if (result.salvageUsed) return 'salvage_success'
  if (result.repairCount > 0) return 'repair_success'
  return 'parse_success'
}

function emptyOutcomeCounts(): Record<ModelOutputProviderMatrixOutcome, number> {
  return {
    parse_success: 0,
    repair_success: 0,
    salvage_success: 0,
    failed_fallback: 0,
    policy_violation: 0,
  }
}

function uniqueOutcomes(samples: ModelOutputProviderMatrixFixture[]): ModelOutputProviderMatrixOutcome[] {
  const present = new Set(samples.map(sample => sample.expectedOutcome))
  return OUTCOME_ORDER.filter(outcome => present.has(outcome))
}

export async function runModelOutputProviderMatrix(
  fixtures: ModelOutputProviderMatrixFixture[] = MODEL_OUTPUT_PROVIDER_MATRIX_FIXTURES,
): Promise<ModelOutputProviderMatrixReport> {
  const samples: ModelOutputProviderMatrixSampleReport[] = []
  const outcomeCounts = emptyOutcomeCounts()
  const mismatches: ModelOutputProviderMatrixMismatch[] = []

  for (const fixture of fixtures) {
    const result = await runModelOutputHarness({
      model: fixture.providerClass,
      preset: fixture.preset,
      user: fixture.user,
      ...(fixture.maxTokens ? { maxTokens: fixture.maxTokens } : {}),
      ...(fixture.policy ? { policy: fixture.policy } : {}),
      ...(fixture.salvagePolicy ? { salvagePolicy: fixture.salvagePolicy } : {}),
    }, executorForFixture(fixture))
    const actualOutcome = classifyModelOutputProviderMatrixOutcome(result)
    outcomeCounts[actualOutcome] += 1
    if (actualOutcome !== fixture.expectedOutcome) {
      mismatches.push({
        sampleId: fixture.sampleId,
        providerClass: fixture.providerClass,
        expectedOutcome: fixture.expectedOutcome,
        actualOutcome,
      })
    }
    samples.push({
      sampleId: fixture.sampleId,
      providerClass: fixture.providerClass,
      title: fixture.title,
      preset: fixture.preset,
      expectedOutcome: fixture.expectedOutcome,
      actualOutcome,
      ok: result.ok,
      parsed: result.parsed,
      schemaValid: result.schemaValid,
      repairCount: result.repairCount,
      salvageUsed: result.salvageUsed,
      fallbackUsed: result.fallbackUsed,
      stopReason: result.stopReason,
      validationErrors: result.validationErrors,
      attempts: result.attempts,
      rawTextArchived: true,
      rawThinkingArchived: Boolean(fixture.rawThinkingText),
      trainingUse: fixture.trainingUse,
    })
  }

  const providerClasses = PROVIDER_CLASS_ORDER.map(providerClass => {
    const providerSamples = fixtures.filter(sample => sample.providerClass === providerClass)
    return {
      providerClass,
      sampleCount: providerSamples.length,
      expectedOutcomes: uniqueOutcomes(providerSamples),
      suitedPresets: PROVIDER_CLASS_PRESETS[providerClass],
      notes: PROVIDER_CLASS_NOTES[providerClass],
    }
  })

  return {
    schemaVersion: 1,
    source: 'local_fixture_provider_matrix',
    localOnly: true,
    trainingUse: 'not_collected',
    providerClassCount: providerClasses.length,
    sampleCount: samples.length,
    providerClasses,
    outcomeCounts,
    failedFixtureSampleIds: samples
      .filter(sample => sample.actualOutcome === 'failed_fallback' || sample.actualOutcome === 'policy_violation')
      .map(sample => sample.sampleId),
    samples,
    mismatches,
  }
}

export function formatModelOutputProviderMatrixReport(report: ModelOutputProviderMatrixReport): string {
  const lines: string[] = [
    '# Model Output Provider Matrix',
    '',
    `source: ${report.source}`,
    `local_only: ${String(report.localOnly)}`,
    `training_use: ${report.trainingUse}`,
    'failed samples stay in local fixtures; they are not collected for training.',
    '',
    '## Summary',
    '',
    `- provider_classes: ${report.providerClassCount}`,
    `- sample_count: ${report.sampleCount}`,
    `- mismatches: ${report.mismatches.length}`,
    ...OUTCOME_ORDER.map(outcome => `- ${outcome}: ${report.outcomeCounts[outcome]}`),
    '',
    '## Provider Suitability',
    '',
  ]

  for (const provider of report.providerClasses) {
    lines.push(
      `### ${provider.providerClass}`,
      '',
      `- sample_count: ${provider.sampleCount}`,
      `- suited_presets: ${provider.suitedPresets.join(', ')}`,
      `- expected_outcomes: ${provider.expectedOutcomes.join(', ')}`,
      ...provider.notes.map(note => `- note: ${note}`),
      '',
    )
  }

  lines.push('## Samples', '')
  for (const sample of report.samples) {
    lines.push(
      `- ${sample.sampleId}: ${sample.providerClass} / ${sample.preset} / expected=${sample.expectedOutcome} / actual=${sample.actualOutcome} / stop=${sample.stopReason ?? 'null'}`,
    )
  }

  if (report.mismatches.length > 0) {
    lines.push('', '## Mismatches', '')
    for (const mismatch of report.mismatches) {
      lines.push(
        `- ${mismatch.sampleId}: expected=${mismatch.expectedOutcome}, actual=${mismatch.actualOutcome}`,
      )
    }
  }

  return `${lines.join('\n')}\n`
}
