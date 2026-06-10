export interface ProjectMapDogfoodToolCall {
  tool?: string
  toolName?: string
}

export interface ProjectMapDogfoodApprovalDenial {
  toolName: string
  reason: string
}

export interface ProjectMapDogfoodAcceptanceInput {
  finalText: string
  evidenceText?: string
  iterations: number
  maxIterations: number
  stopReason?: string | null
  taskStatus?: string
  toolCalls: ProjectMapDogfoodToolCall[]
  approvalDenials: ProjectMapDogfoodApprovalDenial[]
  systemPrompt?: string
  promptInjected?: boolean
}

export interface ProjectMapDogfoodAcceptanceResult {
  ok: boolean
  failures: string[]
  checks: {
    projectMapUsed: boolean
    promptInjected: boolean
    withinIterationBudget: boolean
    completed: boolean
    noUnauthorizedToolAttempts: boolean
    finalAnswerOnObjective: boolean
    finalAnswerComplete: boolean
    finalAnswerConsistentWithEvidence: boolean
  }
}

export function evaluateProjectMapDogfoodAcceptance(
  input: ProjectMapDogfoodAcceptanceInput,
): ProjectMapDogfoodAcceptanceResult {
  const toolNames = input.toolCalls.map((call) => call.tool ?? call.toolName ?? '')
  const projectMapUsed = toolNames.includes('ProjectMap')
  const promptInjected = input.promptInjected ?? (input.systemPrompt ?? '').includes('<project_map>')
  const withinIterationBudget = input.iterations > 0 && input.iterations <= input.maxIterations
  const completed = input.stopReason === 'end_turn'
    && input.taskStatus !== 'blocked'
    && input.taskStatus !== 'waiting_user'
    && input.taskStatus !== 'drifted'
  const noUnauthorizedToolAttempts = input.approvalDenials.length === 0
  const finalAnswerOnObjective = isRuntimeControlPlaneAnswer(input.finalText)
  const finalAnswerComplete = isCompleteFinalAnswer(input.finalText)
  const finalAnswerConsistentWithEvidence = isFinalAnswerConsistentWithEvidence(input.finalText, input.evidenceText ?? '')

  const failures: string[] = []
  if (!projectMapUsed) failures.push('project_map_not_used')
  if (!promptInjected) failures.push('project_map_prompt_not_injected')
  if (!withinIterationBudget) failures.push('iteration_budget_exceeded')
  if (!completed) failures.push(`not_completed:${input.stopReason ?? 'unknown'}`)
  for (const denial of input.approvalDenials) {
    failures.push(`unauthorized_tool_attempt:${denial.toolName}`)
  }
  if (!finalAnswerOnObjective) failures.push('final_answer_off_objective')
  if (!finalAnswerComplete) failures.push('final_answer_incomplete')
  if (!finalAnswerConsistentWithEvidence) failures.push('final_answer_contradicts_project_map_evidence')

  return {
    ok: failures.length === 0,
    failures,
    checks: {
      projectMapUsed,
      promptInjected,
      withinIterationBudget,
      completed,
      noUnauthorizedToolAttempts,
      finalAnswerOnObjective,
      finalAnswerComplete,
      finalAnswerConsistentWithEvidence,
    },
  }
}

function isRuntimeControlPlaneAnswer(text: string): boolean {
  const normalized = text.toLowerCase()
  return /\bproject\s*map\b/i.test(normalized)
    && normalized.includes('runtime control plane')
}

function isCompleteFinalAnswer(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 40) return false
  if (!/[.!?。！？)`\]]$/.test(trimmed)) return false

  if (/^\s*Conclusion:/im.test(trimmed)) {
    return /^\s*Conclusion:/im.test(trimmed)
      && /^\s*Evidence:/im.test(trimmed)
      && /^\s*Uncertainty:/im.test(trimmed)
      && /^\s*Next:/im.test(trimmed)
  }

  return true
}

function isFinalAnswerConsistentWithEvidence(finalText: string, evidenceText: string): boolean {
  if (!hasVerificationProfileLifecycleEvidence(evidenceText)) return true
  const finalHasPositiveLifecycleClaim = /(?:projectMapVerificationProfileIds|expand(?:s|ed)? .*verification profile|verification profile ids?.{0,80}TaskVerify|TaskCreate.{0,80}TaskVerify|lifecycle bridge|now mapped|wired into|integrat(?:ed|ion).{0,80}TaskVerify)/is
    .test(finalText)
  if (finalHasPositiveLifecycleClaim) return true

  return !/(?:no|without|lacks?|missing|has no|not yet|not currently).{0,80}(?:lifecycle integration|execution lifecycle|TaskCreate\s*\/\s*TaskVerify|TaskVerify)|\bdead data\b|static.{0,40}dead data/is
    .test(finalText)
}

function hasVerificationProfileLifecycleEvidence(evidenceText: string): boolean {
  return /(?:projectMapVerificationProfileIds|expandProjectMapVerificationProfiles|projectMapProfileCommandChecks|Project Map verification profiles:)/s
    .test(evidenceText)
}
