/**
 * Session insights endpoint — /v1/insights/:sessionId
 * Provides trace analysis, complexity metrics, and skill match scores
 * for a given session. Feeds L3 data pipeline.
 */

import type * as http from 'node:http'
import { loadSession } from '../history/sessions.js'
import { analyzeSession, type AnalyzedTrace } from '../skills/trace-analyzer.js'
import { isWorthSynthesizing } from '../skills/synthesizer.js'
import { logWarn } from '../logger.js'
import { getSkillIndex } from '../skills/injection.js'
import { matchSkills } from '../skills/matcher.js'
import { extractUserQuery } from '../skills/injection.js'
import { scoreSession, type QualityScore } from '../data/quality.js'

export interface SessionInsight {
  sessionId: string
  messageCount: number
  model: string
  duration: string
  complexity: number
  toolsUsed: string[]
  toolCallCount: number
  errorRecoveryCount: number
  workflowStepCount: number
  topKeywords: string[]
  worthSynthesizing: boolean
  worthReason?: string
  matchedSkills: Array<{ id: string; name: string; score: number }>
  quality: QualityScore
}

function traceToInsight(
  sessionId: string,
  trace: AnalyzedTrace,
  model: string,
  messageCount: number,
  duration: string,
  matchedSkills: Array<{ id: string; name: string; score: number }>,
  quality: QualityScore,
): SessionInsight {
  const check = isWorthSynthesizing(trace)
  return {
    sessionId,
    messageCount,
    model,
    duration,
    complexity: trace.complexity,
    toolsUsed: trace.toolsUsed,
    toolCallCount: trace.toolCalls.length,
    errorRecoveryCount: trace.errorRecoveries.length,
    workflowStepCount: trace.workflow.length,
    topKeywords: trace.keywords.slice(0, 10),
    worthSynthesizing: check.worth,
    worthReason: check.reason,
    matchedSkills,
    quality,
  }
}

export async function handleInsights(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string,
): Promise<void> {
  if (!sessionId) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Session ID required', type: 'invalid_request_error' } }))
    return
  }

  const session = await loadSession(sessionId)
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `Session not found: ${sessionId}`, type: 'not_found_error' } }))
    return
  }

  const trace = analyzeSession(session)

  // Match against existing skills
  let matchedSkills: Array<{ id: string; name: string; score: number }> = []
  try {
    const index = await getSkillIndex()
    if (index.docCount > 0) {
      const query = extractUserQuery(session.messages as unknown[])
      const matches = matchSkills(query, index, { topK: 5, threshold: 0.05 })
      matchedSkills = matches.map(m => ({
        id: m.skill.id,
        name: m.skill.name,
        score: Math.round(m.score * 1000) / 1000,
      }))
    }
  } catch (e) {
    logWarn('insights', `Skill matching failed (non-fatal): ${e}`)
  }

  const createdAt = new Date(session.meta.createdAt).getTime()
  const updatedAt = new Date(session.meta.updatedAt).getTime()
  const durationMs = updatedAt - createdAt
  const duration = durationMs > 0
    ? `${Math.round(durationMs / 1000)}s`
    : 'unknown'

  const quality = scoreSession(session)

  const insight = traceToInsight(
    sessionId,
    trace,
    session.meta.model,
    session.messages.length,
    duration,
    matchedSkills,
    quality,
  )

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(insight, null, 2))
}

// ─── Batch insights ───

export interface BatchInsightSummary {
  sessionCount: number
  averageComplexity: number
  averageQuality: number
  totalToolCalls: number
  totalErrorRecoveries: number
  modelDistribution: Record<string, number>
  topKeywords: Array<{ keyword: string; count: number }>
  worthSynthesizing: number
  sessions: Array<{ id: string; complexity: number; quality: number; model: string }>
}

export async function handleBatchInsights(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const { listSessions } = await import('../native/session.js')
  const rawSessions = listSessions()
  const metas = rawSessions.slice(0, 500).map(s => ({
    id: s.id,
    model: s.model,
    updatedAt: new Date(s.updatedAt).toISOString(),
    messageCount: s.turns.length,
  }))

  if (metas.length === 0) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      sessionCount: 0, averageComplexity: 0, averageQuality: 0,
      totalToolCalls: 0, totalErrorRecoveries: 0,
      modelDistribution: {}, topKeywords: [], worthSynthesizing: 0, sessions: [],
    }))
    return
  }

  let totalComplexity = 0
  let totalQuality = 0
  let totalToolCalls = 0
  let totalRecoveries = 0
  let worthCount = 0
  const modelDist: Record<string, number> = {}
  const keywordCounts = new Map<string, number>()
  const sessionSummaries: Array<{ id: string; complexity: number; quality: number; model: string }> = []

  for (const meta of metas) {
    if (meta.messageCount < 2) continue

    let session: any
    try {
      session = await loadSession(meta.id)
    } catch {
      continue
    }
    if (!session) continue

    let trace: AnalyzedTrace
    let quality: QualityScore
    try {
      trace = analyzeSession(session)
      quality = scoreSession(session)
    } catch {
      continue // skip sessions in incompatible format
    }

    totalComplexity += trace.complexity
    totalQuality += quality.overall
    totalToolCalls += trace.toolCalls.length
    totalRecoveries += trace.errorRecoveries.length

    modelDist[meta.model] = (modelDist[meta.model] ?? 0) + 1

    for (const kw of trace.keywords.slice(0, 5)) {
      keywordCounts.set(kw, (keywordCounts.get(kw) ?? 0) + 1)
    }

    const check = isWorthSynthesizing(trace)
    if (check.worth) worthCount++

    sessionSummaries.push({
      id: meta.id,
      complexity: trace.complexity,
      quality: quality.overall,
      model: meta.model,
    })
  }

  const n = sessionSummaries.length
  const topKeywords = [...keywordCounts.entries()]
    .map(([keyword, count]) => ({ keyword, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)

  const summary: BatchInsightSummary = {
    sessionCount: n,
    averageComplexity: n > 0 ? Math.round(totalComplexity / n) : 0,
    averageQuality: n > 0 ? Math.round(totalQuality / n) : 0,
    totalToolCalls,
    totalErrorRecoveries: totalRecoveries,
    modelDistribution: modelDist,
    topKeywords,
    worthSynthesizing: worthCount,
    sessions: sessionSummaries.sort((a, b) => b.quality - a.quality).slice(0, 50),
  }

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(summary, null, 2))
}
