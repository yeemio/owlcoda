import { basename } from 'node:path'
import type { BenchmarkCaseFixture, BenchmarkEvalPolicy, BenchmarkSchemaValidation } from './types.js'

export interface BenchmarkEvalPacket {
  caseId: string
  taskPrompt: string
  evalHooks: {
    expectedArtifactPaths: string[]
    auditFields: BenchmarkEvalPolicy['auditFields']
    timeoutMs: number
    keepalive: BenchmarkEvalPolicy['keepalive']
    comparisonHarness: BenchmarkEvalPolicy['comparisonHarness']
    sectionPolicy?: BenchmarkEvalPolicy['sectionPolicy']
  }
}

const WORKSPACE_PLACEHOLDER = '__WORKSPACE__'
const MIN_LONG_TASK_TIMEOUT_MS = 15 * 60 * 1000

const PROMPT_META_PATTERNS = [
  /\btask_no_progress\b/i,
  /\btelemetry\b/i,
  /\beval hooks?\b/i,
  /\baudit fields?\b/i,
  /\bruntime observations?\b/i,
  /\btool sequence\b/i,
]

export function renderBenchmarkTaskPrompt(fixture: BenchmarkCaseFixture, workspaceDir: string): string {
  return fixture.prompt.replaceAll(WORKSPACE_PLACEHOLDER, workspaceDir)
}

export function buildBenchmarkEvalPacket(fixture: BenchmarkCaseFixture, workspaceDir: string): BenchmarkEvalPacket {
  return {
    caseId: fixture.caseId,
    taskPrompt: renderBenchmarkTaskPrompt(fixture, workspaceDir),
    evalHooks: {
      expectedArtifactPaths: fixture.evalPolicy.expectedArtifactPaths.map(path => renderTemplatePath(path, workspaceDir)),
      auditFields: [...fixture.evalPolicy.auditFields],
      timeoutMs: fixture.evalPolicy.timeoutMs,
      keepalive: fixture.evalPolicy.keepalive,
      comparisonHarness: fixture.evalPolicy.comparisonHarness,
      ...(fixture.evalPolicy.sectionPolicy ? { sectionPolicy: { ...fixture.evalPolicy.sectionPolicy } } : {}),
    },
  }
}

export function validateBenchmarkEvalMethodology(fixture: BenchmarkCaseFixture): BenchmarkSchemaValidation {
  const issues: string[] = []
  const policy = fixture.evalPolicy

  if (!policy || typeof policy !== 'object') {
    return { ok: false, issues: [`${fixture.caseId}: evalPolicy is required`] }
  }

  for (const pattern of PROMPT_META_PATTERNS) {
    if (pattern.test(fixture.prompt)) {
      issues.push(`${fixture.caseId}: task prompt contains eval/runtime meta term matching ${pattern.source}`)
    }
  }

  const fileDeliverable = fixture.deliverableMode !== 'read_only_review' && fixture.deliverableMode !== 'text_deliverable'
  if (fileDeliverable && policy.expectedArtifactPaths.length === 0) {
    issues.push(`${fixture.caseId}: file-delivery eval must declare exact expectedArtifactPaths`)
  }

  for (const path of policy.expectedArtifactPaths) {
    if (!path.startsWith(`${WORKSPACE_PLACEHOLDER}/`)) {
      issues.push(`${fixture.caseId}: expectedArtifactPath must be an absolute workspace template: ${path}`)
    }
    if (path.endsWith('/')) {
      issues.push(`${fixture.caseId}: expectedArtifactPath must name a file, not a directory: ${path}`)
    }
  }

  const artifactBasenames = policy.expectedArtifactPaths.map(path => basename(path))
  for (const output of fixture.expectedOutputs) {
    if (output === 'chat report') continue
    if (!artifactBasenames.includes(output)) {
      issues.push(`${fixture.caseId}: expected output ${output} is missing from exact expectedArtifactPaths`)
    }
  }

  if (!policy.auditFields.includes('artifact_list')) {
    issues.push(`${fixture.caseId}: evalPolicy.auditFields must include artifact_list`)
  }
  if (!policy.auditFields.includes('final_status')) {
    issues.push(`${fixture.caseId}: evalPolicy.auditFields must include final_status`)
  }
  if (!policy.auditFields.includes('tool_sequence')) {
    issues.push(`${fixture.caseId}: evalPolicy.auditFields must include tool_sequence`)
  }

  if (policy.timeoutMs < MIN_LONG_TASK_TIMEOUT_MS && policy.keepalive !== 'progress_sentinel') {
    issues.push(`${fixture.caseId}: real eval timeout must be >= 15min unless progress_sentinel keepalive is enabled`)
  }

  if (policy.comparisonHarness === 'expect_tui') {
    issues.push(`${fixture.caseId}: expect_tui is allowed only as an explicit external comparison wrapper, not release smoke truth`)
  }

  if (fixture.caseId === 'deck-46p' || fixture.caseId === 'deck-46p-realistic') {
    const sectionPolicy = policy.sectionPolicy
    if (!sectionPolicy) {
      issues.push(`${fixture.caseId}: long-deck eval must declare sectionPolicy`)
    } else {
      if ((sectionPolicy.smokeMinSections ?? 0) < 30) {
        issues.push(`${fixture.caseId}: long-deck smokeMinSections must be at least 30`)
      }
      if (sectionPolicy.heavyExactSections !== 46) {
        issues.push(`${fixture.caseId}: long-deck heavyExactSections must remain 46`)
      }
      if (sectionPolicy.exactSectionsGate !== 'heavy_eval') {
        issues.push(`${fixture.caseId}: exact long-deck page count belongs to heavy_eval, not release_smoke`)
      }
    }
  }

  return { ok: issues.length === 0, issues }
}

function renderTemplatePath(path: string, workspaceDir: string): string {
  return path.replaceAll(WORKSPACE_PLACEHOLDER, workspaceDir)
}
