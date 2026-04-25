/**
 * Data quality scorer — evaluates session quality for training purposes.
 *
 * Scores sessions on multiple dimensions:
 * - Coherence: alternating user/assistant turns, no missing turns
 * - Informativeness: content length, variety
 * - Tool richness: diversity and success rate of tool calls
 * - Completeness: session reached a natural end (not abandoned)
 * - Complexity: from trace-analyzer
 *
 * Returns a 0-100 score with dimension breakdown.
 */

import type { Session, SessionMessage } from '../history/sessions.js'
import { analyzeSession, type AnalyzedTrace } from '../skills/trace-analyzer.js'

// ─── Types ───

export interface QualityScore {
  /** Overall quality (0-100) */
  overall: number
  /** Dimension scores (0-1 each) */
  dimensions: {
    coherence: number
    informativeness: number
    toolRichness: number
    completeness: number
    complexity: number
  }
  /** Reasons for low scores */
  issues: string[]
}

// ─── Scoring functions ───

/**
 * Coherence: well-formed conversation structure
 */
function scoreCoherence(messages: SessionMessage[]): { score: number; issues: string[] } {
  const issues: string[] = []
  if (messages.length < 2) {
    return { score: 0, issues: ['Too few messages'] }
  }

  let score = 1.0

  // Check for proper turn alternation
  let prevRole = ''
  let violations = 0
  for (const msg of messages) {
    if (msg.role === prevRole && msg.role === 'assistant') {
      violations++
    }
    prevRole = msg.role
  }
  if (violations > 0) {
    score -= 0.2 * Math.min(violations, 3)
    issues.push(`${violations} consecutive same-role turns`)
  }

  // First message should be user
  if (messages[0].role !== 'user') {
    score -= 0.1
    issues.push('Session does not start with user message')
  }

  // Last message should be assistant
  if (messages[messages.length - 1].role !== 'assistant') {
    score -= 0.15
    issues.push('Session does not end with assistant message')
  }

  return { score: Math.max(0, score), issues }
}

/**
 * Informativeness: content quality and variety
 */
function scoreInformativeness(messages: SessionMessage[]): { score: number; issues: string[] } {
  const issues: string[] = []

  let totalChars = 0
  let userChars = 0
  let assistantChars = 0

  for (const msg of messages) {
    const len = contentLength(msg.content)
    totalChars += len
    if (msg.role === 'user') userChars += len
    if (msg.role === 'assistant') assistantChars += len
  }

  if (totalChars < 100) {
    issues.push('Very short conversation')
    return { score: 0.1, issues }
  }

  let score = 0

  // Length score (0-0.4): log scale, max at ~5000 chars
  score += Math.min(0.4, 0.4 * Math.log(totalChars + 1) / Math.log(5001))

  // Balance score (0-0.3): user and assistant both contribute
  if (userChars > 0 && assistantChars > 0) {
    const ratio = Math.min(userChars, assistantChars) / Math.max(userChars, assistantChars)
    score += 0.3 * Math.min(ratio * 2, 1)
  }

  // Turn count score (0-0.3): more turns = more informative
  const turnCount = messages.length
  score += Math.min(0.3, 0.3 * Math.log(turnCount + 1) / Math.log(21))

  return { score: Math.min(1, score), issues }
}

/**
 * Tool richness: diversity and success of tool calls
 */
function scoreToolRichness(trace: AnalyzedTrace): { score: number; issues: string[] } {
  const issues: string[] = []

  if (trace.toolCalls.length === 0) {
    return { score: 0.3, issues: ['No tool calls (text-only conversation)'] }
  }

  let score = 0

  // Tool count score (0-0.3)
  score += Math.min(0.3, 0.3 * Math.log(trace.toolCalls.length + 1) / Math.log(11))

  // Tool diversity (0-0.3)
  const diversity = trace.toolsUsed.length / Math.max(trace.toolCalls.length, 1)
  score += 0.3 * diversity

  // Success rate (0-0.2)
  const errors = trace.toolCalls.filter(tc => tc.isError).length
  const successRate = 1 - errors / trace.toolCalls.length
  score += 0.2 * successRate

  // Error recovery bonus (0-0.2)
  if (trace.errorRecoveries.length > 0) {
    score += Math.min(0.2, 0.1 * trace.errorRecoveries.length)
  }

  if (errors > trace.toolCalls.length * 0.5) {
    issues.push('High tool error rate')
  }

  return { score: Math.min(1, score), issues }
}

/**
 * Completeness: did the session reach a natural end?
 */
function scoreCompleteness(messages: SessionMessage[]): { score: number; issues: string[] } {
  const issues: string[] = []

  if (messages.length < 2) {
    return { score: 0, issues: ['Incomplete session'] }
  }

  let score = 0.5 // base

  const lastMsg = messages[messages.length - 1]
  if (lastMsg.role === 'assistant') {
    score += 0.3
    // Check for completion indicators in last message
    const text = contentToString(lastMsg.content).toLowerCase()
    if (text.includes('done') || text.includes('complete') || text.includes('finish') ||
        text.includes('success') || text.includes('✓') || text.includes('✅')) {
      score += 0.2
    }
  } else {
    issues.push('Session ended on user message (possibly abandoned)')
  }

  return { score: Math.min(1, score), issues }
}

// ─── Helpers ───

function contentLength(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) {
    return content.reduce((sum: number, block: unknown) => {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>
        if (b.type === 'text' && typeof b.text === 'string') return sum + b.text.length
        if (b.type === 'tool_result' && typeof b.content === 'string') return sum + b.content.length
      }
      return sum
    }, 0)
  }
  return 0
}

function contentToString(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b: unknown) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text')
      .map((b: unknown) => String((b as Record<string, unknown>).text ?? ''))
      .join('\n')
  }
  return ''
}

// ─── Main scorer ───

/**
 * Score a session's quality for training purposes.
 */
export function scoreSession(session: Session): QualityScore {
  const trace = analyzeSession(session)
  const issues: string[] = []

  const coherence = scoreCoherence(session.messages)
  const informativeness = scoreInformativeness(session.messages)
  const toolRichness = scoreToolRichness(trace)
  const completeness = scoreCompleteness(session.messages)
  const complexity = trace.complexity / 100

  issues.push(...coherence.issues, ...informativeness.issues, ...toolRichness.issues, ...completeness.issues)

  // Weighted combination
  const overall = Math.round(
    coherence.score * 20 +
    informativeness.score * 25 +
    toolRichness.score * 20 +
    completeness.score * 15 +
    complexity * 20,
  )

  return {
    overall,
    dimensions: {
      coherence: Math.round(coherence.score * 100) / 100,
      informativeness: Math.round(informativeness.score * 100) / 100,
      completeness: Math.round(completeness.score * 100) / 100,
      toolRichness: Math.round(toolRichness.score * 100) / 100,
      complexity: Math.round(complexity * 100) / 100,
    },
    issues,
  }
}

// ─── Aggregate report ───

export interface QualityReport {
  totalSessions: number
  scoredSessions: number
  averageQuality: number
  medianQuality: number
  distribution: { excellent: number; good: number; fair: number; poor: number }
  averageDimensions: {
    coherence: number
    informativeness: number
    toolRichness: number
    completeness: number
    complexity: number
  }
  topIssues: Array<{ issue: string; count: number }>
}

export function aggregateQualityReport(scores: QualityScore[]): QualityReport {
  if (scores.length === 0) {
    return {
      totalSessions: 0,
      scoredSessions: 0,
      averageQuality: 0,
      medianQuality: 0,
      distribution: { excellent: 0, good: 0, fair: 0, poor: 0 },
      averageDimensions: { coherence: 0, informativeness: 0, toolRichness: 0, completeness: 0, complexity: 0 },
      topIssues: [],
    }
  }

  const sorted = [...scores].map(s => s.overall).sort((a, b) => a - b)
  const n = sorted.length
  const median = n % 2 === 1 ? sorted[Math.floor(n / 2)] : Math.round((sorted[n / 2 - 1] + sorted[n / 2]) / 2)
  const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / n)

  const distribution = { excellent: 0, good: 0, fair: 0, poor: 0 }
  for (const s of sorted) {
    if (s >= 80) distribution.excellent++
    else if (s >= 60) distribution.good++
    else if (s >= 40) distribution.fair++
    else distribution.poor++
  }

  const dimSums = { coherence: 0, informativeness: 0, toolRichness: 0, completeness: 0, complexity: 0 }
  const issueMap = new Map<string, number>()

  for (const score of scores) {
    dimSums.coherence += score.dimensions.coherence
    dimSums.informativeness += score.dimensions.informativeness
    dimSums.toolRichness += score.dimensions.toolRichness
    dimSums.completeness += score.dimensions.completeness
    dimSums.complexity += score.dimensions.complexity

    for (const issue of score.issues) {
      issueMap.set(issue, (issueMap.get(issue) ?? 0) + 1)
    }
  }

  const averageDimensions = {
    coherence: Math.round((dimSums.coherence / n) * 100) / 100,
    informativeness: Math.round((dimSums.informativeness / n) * 100) / 100,
    toolRichness: Math.round((dimSums.toolRichness / n) * 100) / 100,
    completeness: Math.round((dimSums.completeness / n) * 100) / 100,
    complexity: Math.round((dimSums.complexity / n) * 100) / 100,
  }

  const topIssues = [...issueMap.entries()]
    .map(([issue, count]) => ({ issue, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  return {
    totalSessions: n,
    scoredSessions: n,
    averageQuality: avg,
    medianQuality: median,
    distribution,
    averageDimensions,
    topIssues,
  }
}
