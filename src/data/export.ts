/**
 * Training data exporter — converts analyzed sessions into fine-tuning format.
 * Part of L3 data pipeline preparation.
 *
 * Formats supported:
 * - "jsonl" — OpenAI-compatible JSONL (messages array per line)
 * - "sharegpt" — ShareGPT format (conversations array)
 * - "insights" — OwlCoda insights (full trace analysis per session)
 */

import { listSessions, loadSession, type SessionMeta } from '../history/sessions.js'
import { analyzeSession, type AnalyzedTrace } from '../skills/trace-analyzer.js'
import { scoreSession } from './quality.js'

// ─── Types ───

export type ExportFormat = 'jsonl' | 'sharegpt' | 'insights'

export interface ExportOptions {
  format: ExportFormat
  /** Max sessions to export (default: all) */
  limit?: number
  /** Min complexity to include (default: 0 — include all) */
  minComplexity?: number
  /** Min messages to include (default: 2) */
  minMessages?: number
  /** Include sessions with tool calls only */
  toolCallsOnly?: boolean
  /** Min quality score to include (0-100, default: 0) */
  minQuality?: number
}

export interface ExportResult {
  format: ExportFormat
  sessionCount: number
  skippedCount: number
  lines: string[]
}

// ─── Conversions ───

interface JsonlMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export function sessionToJsonl(messages: Array<{ role: string; content: unknown }>): string | null {
  const jsonlMessages: JsonlMessage[] = []

  for (const msg of messages) {
    const role = msg.role as 'user' | 'assistant'
    if (role !== 'user' && role !== 'assistant') continue

    let content: string
    if (typeof msg.content === 'string') {
      content = msg.content
    } else if (Array.isArray(msg.content)) {
      const texts = (msg.content as Array<Record<string, unknown>>)
        .filter(b => b.type === 'text')
        .map(b => String(b.text ?? ''))
      content = texts.join('\n')
    } else {
      continue
    }

    if (content.trim()) {
      jsonlMessages.push({ role, content })
    }
  }

  if (jsonlMessages.length < 2) return null
  return JSON.stringify({ messages: jsonlMessages })
}

interface ShareGptTurn {
  from: 'human' | 'gpt'
  value: string
}

export function sessionToShareGpt(meta: SessionMeta, messages: Array<{ role: string; content: unknown }>): string | null {
  const turns: ShareGptTurn[] = []

  for (const msg of messages) {
    const from = msg.role === 'user' ? 'human' : msg.role === 'assistant' ? 'gpt' : null
    if (!from) continue

    let value: string
    if (typeof msg.content === 'string') {
      value = msg.content
    } else if (Array.isArray(msg.content)) {
      const texts = (msg.content as Array<Record<string, unknown>>)
        .filter(b => b.type === 'text')
        .map(b => String(b.text ?? ''))
      value = texts.join('\n')
    } else {
      continue
    }

    if (value.trim()) {
      turns.push({ from, value })
    }
  }

  if (turns.length < 2) return null
  return JSON.stringify({ conversations: turns, id: meta.id, model: meta.model })
}

export function sessionToInsight(meta: SessionMeta, trace: AnalyzedTrace, messages: Array<{ role: string; content: unknown }>): string {
  // Inline quality scoring for insights format
  const session = { meta, messages } as any
  const quality = scoreSession(session)

  return JSON.stringify({
    sessionId: meta.id,
    messageCount: meta.messageCount,
    model: meta.model,
    complexity: trace.complexity,
    toolsUsed: trace.toolsUsed,
    toolCallCount: trace.toolCalls.length,
    errorRecoveryCount: trace.errorRecoveries.length,
    workflowStepCount: trace.workflow.length,
    topKeywords: trace.keywords.slice(0, 10),
    quality: quality.overall,
    qualityDimensions: quality.dimensions,
  })
}

// ─── Main export ───

export async function exportTrainingData(options: ExportOptions): Promise<ExportResult> {
  const { format, limit, minComplexity = 0, minMessages = 2, toolCallsOnly = false, minQuality = 0 } = options

  const metas = await listSessions(limit ?? 1000)
  const lines: string[] = []
  let skipped = 0

  for (const meta of metas) {
    if (meta.messageCount < minMessages) {
      skipped++
      continue
    }

    const session = await loadSession(meta.id)
    if (!session) {
      skipped++
      continue
    }

    const trace = analyzeSession(session)

    if (trace.complexity < minComplexity) {
      skipped++
      continue
    }

    if (toolCallsOnly && trace.toolCalls.length === 0) {
      skipped++
      continue
    }

    // Quality filter
    if (minQuality > 0) {
      const quality = scoreSession(session)
      if (quality.overall < minQuality) {
        skipped++
        continue
      }
    }

    let line: string | null = null
    switch (format) {
      case 'jsonl':
        line = sessionToJsonl(session.messages)
        break
      case 'sharegpt':
        line = sessionToShareGpt(meta, session.messages)
        break
      case 'insights':
        line = sessionToInsight(meta, trace, session.messages)
        break
    }

    if (line) {
      lines.push(line)
    } else {
      skipped++
    }
  }

  return {
    format,
    sessionCount: lines.length,
    skippedCount: skipped,
    lines,
  }
}
