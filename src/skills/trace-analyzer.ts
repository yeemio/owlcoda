/**
 * Session trace analyzer — extracts patterns from conversation sessions.
 * Parses tool call sequences, error recovery, multi-step workflows.
 * Output feeds into skill synthesizer (Round 105).
 */

import type { Session, SessionMessage } from '../history/sessions.js'

// ─── Types ───

export interface ToolCall {
  /** Sequential index in the session */
  index: number
  /** Tool name (e.g., "bash", "file_write", "grep") */
  name: string
  /** Tool input (truncated for storage) */
  input: Record<string, unknown>
  /** Whether the tool result was an error */
  isError: boolean
  /** Timestamp from the containing message */
  timestamp: string
}

export interface ErrorRecovery {
  /** The tool call that failed */
  failedCall: ToolCall
  /** Tool calls made to recover (between error and next success of same tool) */
  recoveryCalls: ToolCall[]
  /** Whether recovery succeeded */
  recovered: boolean
}

export interface WorkflowStep {
  /** Step number in the workflow */
  order: number
  /** What happened (e.g., "Read file src/foo.ts", "Ran tests") */
  description: string
  /** Tools used in this step */
  tools: string[]
}

export interface AnalyzedTrace {
  /** Session ID */
  sessionId: string
  /** Model used */
  model: string
  /** All tool calls in order */
  toolCalls: ToolCall[]
  /** Error → recovery patterns */
  errorRecoveries: ErrorRecovery[]
  /** High-level workflow steps (collapsed from raw tool calls) */
  workflow: WorkflowStep[]
  /** Unique tool names used */
  toolsUsed: string[]
  /** Complexity score (0-100) */
  complexity: number
  /** Number of user/assistant turns */
  turnCount: number
  /** Duration in seconds (first to last message) */
  durationSec: number
  /** Keywords extracted from user messages */
  keywords: string[]
}

// ─── Content block helpers ───

interface ContentBlock {
  type: string
  [key: string]: unknown
}

function isContentBlockArray(c: unknown): c is ContentBlock[] {
  return Array.isArray(c) && c.length > 0 && typeof c[0] === 'object' && c[0] !== null && 'type' in c[0]
}

function getTextContent(msg: SessionMessage): string {
  if (typeof msg.content === 'string') return msg.content
  if (!isContentBlockArray(msg.content)) return ''
  return msg.content
    .filter(b => b.type === 'text')
    .map(b => String(b.text ?? ''))
    .join('\n')
}

// ─── Extract tool calls ───

export function extractToolCalls(session: Session): ToolCall[] {
  const calls: ToolCall[] = []
  let idx = 0

  // Pass 1: collect tool_use from assistant messages
  const pendingCalls = new Map<string, ToolCall>()

  for (const msg of session.messages) {
    if (!isContentBlockArray(msg.content)) continue

    if (msg.role === 'assistant') {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          const call: ToolCall = {
            index: idx++,
            name: String(block.name ?? 'unknown'),
            input: truncateInput(block.input as Record<string, unknown> | undefined),
            isError: false,
            timestamp: msg.timestamp,
          }
          const id = String(block.id ?? '')
          if (id) pendingCalls.set(id, call)
          calls.push(call)
        }
      }
    }

    if (msg.role === 'user') {
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          const id = String(block.tool_use_id ?? '')
          const pending = pendingCalls.get(id)
          if (pending) {
            pending.isError = Boolean(block.is_error)
            pendingCalls.delete(id)
          }
        }
      }
    }
  }

  return calls
}

function truncateInput(input: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!input) return {}
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.length > 200) {
      result[k] = v.slice(0, 200) + '…'
    } else {
      result[k] = v
    }
  }
  return result
}

// ─── Extract error recoveries ───

export function extractErrorRecoveries(calls: ToolCall[]): ErrorRecovery[] {
  const recoveries: ErrorRecovery[] = []

  for (let i = 0; i < calls.length; i++) {
    if (!calls[i].isError) continue

    const failed = calls[i]
    const recoveryCalls: ToolCall[] = []
    let recovered = false

    // Look ahead for recovery attempts
    for (let j = i + 1; j < calls.length && j < i + 10; j++) {
      recoveryCalls.push(calls[j])
      if (calls[j].name === failed.name && !calls[j].isError) {
        recovered = true
        break
      }
    }

    recoveries.push({ failedCall: failed, recoveryCalls, recovered })
  }

  return recoveries
}

// ─── Build workflow steps ───

export function buildWorkflow(calls: ToolCall[]): WorkflowStep[] {
  if (calls.length === 0) return []

  const steps: WorkflowStep[] = []
  let currentTools: string[] = [calls[0].name]
  let stepStart = 0

  for (let i = 1; i < calls.length; i++) {
    const prev = calls[i - 1]
    const curr = calls[i]

    // New step when: different tool category, or error boundary, or gap > 3 calls of same tool
    const sameCategory = getToolCategory(prev.name) === getToolCategory(curr.name)
    const errorBoundary = prev.isError && !curr.isError && curr.name !== prev.name

    if (!sameCategory || errorBoundary) {
      steps.push({
        order: steps.length + 1,
        description: describeStep(calls.slice(stepStart, i)),
        tools: [...new Set(currentTools)],
      })
      currentTools = [curr.name]
      stepStart = i
    } else {
      currentTools.push(curr.name)
    }
  }

  // Final step
  steps.push({
    order: steps.length + 1,
    description: describeStep(calls.slice(stepStart)),
    tools: [...new Set(currentTools)],
  })

  return steps
}

function getToolCategory(name: string): string {
  const categories: Record<string, string[]> = {
    read: ['file_read', 'glob', 'grep', 'view', 'Read', 'search'],
    write: ['file_write', 'file_edit', 'Write', 'edit', 'create'],
    execute: ['bash', 'shell', 'terminal', 'Bash'],
    navigate: ['cd', 'ls', 'find', 'list_dir'],
  }
  for (const [cat, tools] of Object.entries(categories)) {
    if (tools.some(t => name.toLowerCase().includes(t.toLowerCase()))) return cat
  }
  return 'other'
}

function describeStep(calls: ToolCall[]): string {
  const names = [...new Set(calls.map(c => c.name))]
  const errors = calls.filter(c => c.isError).length

  if (names.length === 1) {
    const n = names[0]
    const count = calls.length
    if (count === 1) return `${n} (${summarizeInput(calls[0])})`
    return `${n} ×${count}${errors ? ` (${errors} errors)` : ''}`
  }

  return names.join(' → ') + (errors ? ` (${errors} errors)` : '')
}

function summarizeInput(call: ToolCall): string {
  const input = call.input
  // Try common input patterns
  if (input.command) return String(input.command).slice(0, 60)
  if (input.path) return String(input.path).slice(0, 60)
  if (input.pattern) return String(input.pattern).slice(0, 60)
  if (input.query) return String(input.query).slice(0, 60)
  const first = Object.values(input)[0]
  if (first) return String(first).slice(0, 40)
  return ''
}

// ─── Keyword extraction ───

export function extractKeywords(session: Session): string[] {
  const userTexts = session.messages
    .filter(m => m.role === 'user')
    .map(m => getTextContent(m))
    .join(' ')

  // Split into words, filter stopwords, normalize
  const words = userTexts
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))

  // Count frequencies
  const freq = new Map<string, number>()
  for (const w of words) {
    freq.set(w, (freq.get(w) ?? 0) + 1)
  }

  // Return top keywords by frequency
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([w]) => w)
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was',
  'were', 'been', 'have', 'has', 'had', 'but', 'not', 'you', 'all',
  'can', 'her', 'his', 'one', 'our', 'out', 'use', 'how', 'its',
  'let', 'may', 'who', 'did', 'get', 'she', 'him', 'his', 'old',
  'see', 'now', 'way', 'each', 'make', 'like', 'than', 'them',
  'then', 'what', 'when', 'will', 'more', 'some', 'just', 'also',
  'into', 'over', 'such', 'take', 'only', 'very', 'much', 'here',
  'there', 'these', 'those', 'about', 'would', 'could', 'should',
  'other', 'which', 'their', 'after', 'before', 'being', 'between',
])

// ─── Complexity scoring ───

export function computeComplexity(
  calls: ToolCall[],
  recoveries: ErrorRecovery[],
  turnCount: number,
): number {
  let score = 0

  // Tool count (0-30 points)
  score += Math.min(30, calls.length * 2)

  // Tool diversity (0-20 points)
  const uniqueTools = new Set(calls.map(c => c.name)).size
  score += Math.min(20, uniqueTools * 5)

  // Error recoveries (0-20 points)
  score += Math.min(20, recoveries.length * 7)

  // Turn count (0-15 points)
  score += Math.min(15, turnCount)

  // Successful recovery bonus (0-15 points)
  const successfulRecoveries = recoveries.filter(r => r.recovered).length
  score += Math.min(15, successfulRecoveries * 5)

  return Math.min(100, score)
}

// ─── Main entry point ───

export function analyzeSession(session: Session): AnalyzedTrace {
  const toolCalls = extractToolCalls(session)
  const errorRecoveries = extractErrorRecoveries(toolCalls)
  const workflow = buildWorkflow(toolCalls)
  const keywords = extractKeywords(session)

  const turnCount = session.messages.length
  const durationSec = computeDuration(session)
  const complexity = computeComplexity(toolCalls, errorRecoveries, turnCount)
  const toolsUsed = [...new Set(toolCalls.map(c => c.name))]

  return {
    sessionId: session.meta.id,
    model: session.meta.model,
    toolCalls,
    errorRecoveries,
    workflow,
    toolsUsed,
    complexity,
    turnCount,
    durationSec,
    keywords,
  }
}

function computeDuration(session: Session): number {
  if (session.messages.length < 2) return 0
  const first = new Date(session.messages[0].timestamp).getTime()
  const last = new Date(session.messages[session.messages.length - 1].timestamp).getTime()
  const sec = Math.round((last - first) / 1000)
  return Number.isFinite(sec) && sec >= 0 ? sec : 0
}
