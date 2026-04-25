/**
 * Skill synthesizer — converts analyzed traces into skill documents.
 * Two modes:
 *   1. Template-based (fast, zero deps) — extracts structure from trace analysis
 *   2. LLM-powered (richer) — sends trace summary to local LLM for natural language synthesis
 */

import type { AnalyzedTrace, ToolCall, ErrorRecovery, WorkflowStep } from './trace-analyzer.js'
import type { SkillDocument, SkillStep, SkillPitfall, SkillVerification } from './schema.js'
import { nameToId } from './schema.js'
import {
  classifyProviderRequestError,
  createProviderHttpDiagnostic,
  formatProviderDiagnostic,
  upstreamRequestIdFromHeaders,
} from '../provider-error.js'

// ─── Types ───

export interface SynthesisOptions {
  /** Synthesis mode */
  mode: 'template' | 'llm'
  /** Override the generated name */
  name?: string
  /** Override the generated description */
  description?: string
  /** Extra tags to add */
  extraTags?: string[]
  /** LLM endpoint (required for mode=llm) */
  llmEndpoint?: string
  /** LLM model name (required for mode=llm) */
  llmModel?: string
}

export interface SynthesisResult {
  skill: SkillDocument
  /** Confidence in the synthesized skill (0-1) */
  confidence: number
  /** Warnings/notes from synthesis */
  warnings: string[]
}

// ─── Minimum thresholds ───

const MIN_TOOL_CALLS = 2
const MIN_COMPLEXITY = 10

/**
 * Check if a trace is worth synthesizing into a skill.
 */
export function isWorthSynthesizing(trace: AnalyzedTrace): { worth: boolean; reason?: string } {
  if (trace.toolCalls.length < MIN_TOOL_CALLS) {
    return { worth: false, reason: `Too few tool calls (${trace.toolCalls.length} < ${MIN_TOOL_CALLS})` }
  }
  if (trace.complexity < MIN_COMPLEXITY) {
    return { worth: false, reason: `Complexity too low (${trace.complexity} < ${MIN_COMPLEXITY})` }
  }
  if (trace.workflow.length === 0) {
    return { worth: false, reason: 'No workflow steps detected' }
  }
  return { worth: true }
}

// ─── Template-based synthesis ───

/**
 * Synthesize a skill using template extraction (fast, zero dependencies).
 */
export function synthesizeTemplate(trace: AnalyzedTrace, options: SynthesisOptions = { mode: 'template' }): SynthesisResult {
  const warnings: string[] = []

  const { worth, reason } = isWorthSynthesizing(trace)
  if (!worth) {
    warnings.push(`Low-quality trace: ${reason}`)
  }

  const name = options.name ?? inferName(trace)
  const id = nameToId(name)
  const description = options.description ?? inferDescription(trace)
  const procedure = buildProcedure(trace.workflow)
  const pitfalls = buildPitfalls(trace.errorRecoveries)
  const verification = buildVerification(trace)
  const tags = buildTags(trace, options.extraTags)
  const whenToUse = buildWhenToUse(trace)

  // Confidence based on trace quality
  let confidence = 0.3
  if (trace.complexity >= 30) confidence += 0.2
  if (trace.errorRecoveries.length > 0) confidence += 0.15
  if (trace.workflow.length >= 3) confidence += 0.15
  if (trace.keywords.length >= 3) confidence += 0.1
  if (trace.toolCalls.length >= 5) confidence += 0.1
  confidence = Math.min(1, confidence)

  const skill: SkillDocument = {
    id,
    name,
    description,
    procedure,
    pitfalls,
    verification,
    tags,
    whenToUse,
    createdFrom: trace.sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    useCount: 0,
    synthesisMode: 'template',
  }

  return { skill, confidence, warnings }
}

// ─── LLM-powered synthesis ───

/**
 * Build a prompt for LLM-based skill synthesis.
 */
export function buildLlmPrompt(trace: AnalyzedTrace): string {
  const lines: string[] = [
    'You are a skill extraction engine. Given a session trace summary, generate a reusable skill document.',
    '',
    '## Session Trace Summary',
    '',
    `- Model: ${trace.model}`,
    `- Tool calls: ${trace.toolCalls.length}`,
    `- Tools used: ${trace.toolsUsed.join(', ')}`,
    `- Error recoveries: ${trace.errorRecoveries.length}`,
    `- Complexity: ${trace.complexity}/100`,
    `- Keywords: ${trace.keywords.join(', ')}`,
    '',
    '### Workflow Steps:',
  ]

  for (const step of trace.workflow) {
    lines.push(`${step.order}. ${step.description} [tools: ${step.tools.join(', ')}]`)
  }

  if (trace.errorRecoveries.length > 0) {
    lines.push('')
    lines.push('### Error Recovery Patterns:')
    for (const r of trace.errorRecoveries) {
      lines.push(`- Failed: ${r.failedCall.name} → Recovered: ${r.recovered ? 'yes' : 'no'} (${r.recoveryCalls.length} steps)`)
    }
  }

  lines.push('')
  lines.push('## Output Format (JSON)')
  lines.push('Respond with ONLY a JSON object (no markdown fencing) matching this schema:')
  lines.push(JSON.stringify({
    name: 'Human-readable skill name',
    description: 'One-sentence description',
    whenToUse: 'When this skill applies (natural language)',
    procedure: [{ order: 1, action: 'Step description', detail: 'Optional detail' }],
    pitfalls: [{ description: 'What can go wrong', mitigation: 'How to avoid it' }],
    verification: [{ check: 'What to verify', expected: 'Expected result' }],
    tags: ['keyword1', 'keyword2'],
  }, null, 2))

  return lines.join('\n')
}

/**
 * Parse LLM response into a SkillDocument. Handles common LLM output quirks.
 */
export function parseLlmResponse(raw: string, trace: AnalyzedTrace): SynthesisResult {
  const warnings: string[] = []

  // Strip markdown fencing if present
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    const fallback = synthesizeTemplate(trace)
    fallback.warnings.push('Failed to parse LLM response as JSON — falling back to template')
    return fallback
  }

  const name = String(parsed.name ?? inferName(trace))
  const id = nameToId(name)

  const skill: SkillDocument = {
    id,
    name,
    description: String(parsed.description ?? ''),
    procedure: Array.isArray(parsed.procedure)
      ? (parsed.procedure as Record<string, unknown>[]).map((s, i) => ({
          order: Number(s.order ?? i + 1),
          action: String(s.action ?? ''),
          detail: s.detail ? String(s.detail) : undefined,
        }))
      : [],
    pitfalls: Array.isArray(parsed.pitfalls)
      ? (parsed.pitfalls as Record<string, unknown>[]).map(p => ({
          description: String(p.description ?? ''),
          mitigation: String(p.mitigation ?? ''),
        }))
      : [],
    verification: Array.isArray(parsed.verification)
      ? (parsed.verification as Record<string, unknown>[]).map(v => ({
          check: String(v.check ?? ''),
          expected: String(v.expected ?? ''),
        }))
      : [],
    tags: Array.isArray(parsed.tags) ? (parsed.tags as string[]).map(String) : trace.keywords.slice(0, 10),
    whenToUse: String(parsed.whenToUse ?? ''),
    createdFrom: trace.sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    useCount: 0,
    synthesisMode: 'llm',
  }

  // Validate minimums
  if (skill.procedure.length === 0) warnings.push('LLM returned no procedure steps')
  if (!skill.description) warnings.push('LLM returned no description')

  const confidence = skill.procedure.length > 0 && skill.description ? 0.8 : 0.4

  return { skill, confidence, warnings }
}

/**
 * Full LLM-based synthesis. Sends trace to local endpoint, parses response.
 */
export async function synthesizeLlm(
  trace: AnalyzedTrace,
  endpoint: string,
  model: string,
): Promise<SynthesisResult> {
  const prompt = buildLlmPrompt(trace)
  const endpointUrl = `${endpoint}/v1/chat/completions`

  try {
    const res = await fetch(endpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      const diagnostic = createProviderHttpDiagnostic(res.status, await res.text(), {
        model,
        endpointUrl,
        upstreamRequestId: upstreamRequestIdFromHeaders(res.headers),
      })
      return {
        ...synthesizeTemplate(trace),
        warnings: [`LLM request failed: ${formatProviderDiagnostic(diagnostic, { includeRequestId: true })}; fell back to template`],
      }
    }

    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
    const content = data?.choices?.[0]?.message?.content ?? ''
    if (!content) {
      return {
        ...synthesizeTemplate(trace),
        warnings: ['LLM returned empty response, fell back to template'],
      }
    }

    return parseLlmResponse(content, trace)
  } catch (err) {
    const diagnostic = classifyProviderRequestError(err, {
      model,
      endpointUrl,
    })
    return {
      ...synthesizeTemplate(trace),
      warnings: [`LLM error: ${formatProviderDiagnostic(diagnostic, { includeRequestId: true })}; fell back to template`],
    }
  }
}

// ─── Main entry point ───

/**
 * Synthesize a skill from a trace, using the specified mode.
 */
export async function synthesize(trace: AnalyzedTrace, options: SynthesisOptions): Promise<SynthesisResult> {
  if (options.mode === 'llm') {
    if (!options.llmEndpoint || !options.llmModel) {
      return {
        ...synthesizeTemplate(trace, options),
        warnings: ['LLM mode requested but no endpoint/model provided, fell back to template'],
      }
    }
    const result = await synthesizeLlm(trace, options.llmEndpoint, options.llmModel)
    // Apply overrides
    if (options.name) {
      result.skill.name = options.name
      result.skill.id = nameToId(options.name)
    }
    if (options.description) result.skill.description = options.description
    if (options.extraTags) result.skill.tags = [...new Set([...result.skill.tags, ...options.extraTags])]
    return result
  }

  return synthesizeTemplate(trace, options)
}

// ─── Inference helpers ───

function inferName(trace: AnalyzedTrace): string {
  const kw = trace.keywords.slice(0, 3)
  if (kw.length > 0) {
    return kw.join('-') + '-workflow'
  }
  if (trace.toolsUsed.length > 0) {
    return trace.toolsUsed.slice(0, 2).join('-') + '-task'
  }
  return `session-${trace.sessionId}`
}

function inferDescription(trace: AnalyzedTrace): string {
  const parts: string[] = []
  if (trace.workflow.length > 0) {
    parts.push(`${trace.workflow.length}-step workflow`)
  }
  if (trace.toolsUsed.length > 0) {
    parts.push(`using ${trace.toolsUsed.join(', ')}`)
  }
  if (trace.errorRecoveries.length > 0) {
    const recovered = trace.errorRecoveries.filter(r => r.recovered).length
    parts.push(`with ${recovered}/${trace.errorRecoveries.length} error recoveries`)
  }
  return parts.join(' ') || 'Synthesized skill from session trace'
}

function buildProcedure(workflow: WorkflowStep[]): SkillStep[] {
  return workflow.map(step => ({
    order: step.order,
    action: step.description,
    detail: step.tools.length > 1 ? `Tools: ${step.tools.join(', ')}` : undefined,
  }))
}

function buildPitfalls(recoveries: ErrorRecovery[]): SkillPitfall[] {
  return recoveries.map(r => ({
    description: `${r.failedCall.name} may fail${summarizeFailure(r.failedCall)}`,
    mitigation: r.recovered
      ? `Recovery: ${r.recoveryCalls.map(c => c.name).join(' → ')}`
      : 'No automatic recovery found — manual intervention needed',
  }))
}

function summarizeFailure(call: ToolCall): string {
  if (call.input.command) return ` (command: ${String(call.input.command).slice(0, 60)})`
  if (call.input.path) return ` (path: ${String(call.input.path).slice(0, 60)})`
  return ''
}

function buildVerification(trace: AnalyzedTrace): SkillVerification[] {
  const verifications: SkillVerification[] = []

  // If last tool call is bash (likely test/build), use as verification
  const lastCall = trace.toolCalls[trace.toolCalls.length - 1]
  if (lastCall && lastCall.name === 'bash' && !lastCall.isError) {
    const cmd = String(lastCall.input.command ?? '')
    if (cmd) {
      verifications.push({
        check: `Run: ${cmd.slice(0, 80)}`,
        expected: 'Command succeeds without errors',
      })
    }
  }

  // If errors were all recovered, note that
  if (trace.errorRecoveries.length > 0) {
    const allRecovered = trace.errorRecoveries.every(r => r.recovered)
    if (allRecovered) {
      verifications.push({
        check: 'All error recovery patterns applied successfully',
        expected: 'No unresolved errors',
      })
    }
  }

  return verifications
}

function buildTags(trace: AnalyzedTrace, extraTags?: string[]): string[] {
  const tags = new Set<string>()

  // Add keywords
  for (const kw of trace.keywords.slice(0, 10)) {
    tags.add(kw)
  }

  // Add tool categories
  for (const tool of trace.toolsUsed) {
    tags.add(tool.toLowerCase())
  }

  // Add extras
  if (extraTags) {
    for (const t of extraTags) tags.add(t)
  }

  return [...tags]
}

function buildWhenToUse(trace: AnalyzedTrace): string {
  const parts: string[] = []

  if (trace.keywords.length > 0) {
    parts.push(`When working with: ${trace.keywords.slice(0, 5).join(', ')}`)
  }

  if (trace.errorRecoveries.length > 0) {
    parts.push(`Especially when ${trace.errorRecoveries[0].failedCall.name} errors are encountered`)
  }

  if (trace.toolsUsed.length > 0) {
    parts.push(`Tasks requiring: ${trace.toolsUsed.join(', ')}`)
  }

  return parts.join('. ') + '.'
}
