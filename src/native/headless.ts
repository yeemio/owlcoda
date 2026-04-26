/**
 * OwlCoda Native Headless Runner
 *
 * Non-interactive single-shot mode: send prompt → run agentic loop → print result → exit.
 * Used by `owlcoda run --native --prompt "..."` and piped stdin.
 */

import { ToolDispatcher } from './dispatch.js'
import {
  createConversation,
  addUserMessage,
  runConversationLoop,
  type ConversationCallbacks,
  type ConversationLoopOptions,
} from './conversation.js'
import { buildNativeToolDefs } from './tool-defs.js'
import { buildSystemPrompt } from './system-prompt.js'
import { formatToolStart, formatToolEnd, formatError, ansi } from './display.js'
import { StreamingMarkdownRenderer } from './markdown.js'
import { saveSession, loadSession, listSessions } from './session.js'
import {
  buildHeadlessApprovalCallback,
  describeApprovalPolicy,
  type HeadlessApprovalRecord,
} from './headless-approval.js'

const DEFAULT_SYSTEM_PROMPT = buildSystemPrompt()
const DEFAULT_RUNTIME_RESUME_RETRIES = 8
const DEFAULT_RUNTIME_RESUME_RETRY_DELAY_MS = 1000
const MAX_RUNTIME_RESUME_RETRY_DELAY_MS = 30_000

export interface HeadlessOptions {
  apiBaseUrl: string
  apiKey: string
  model: string
  prompt: string
  maxTokens?: number
  systemPrompt?: string
  /** If true, output JSON with structured result contract */
  json?: boolean
  /** If true, auto-approve all tool executions */
  autoApprove?: boolean
  /** Resume an existing session by ID ('last' resolves to most recent) */
  resumeSession?: string
  /** Whether to save the session after completion */
  saveSessionOnComplete?: boolean
}

export interface HeadlessResult {
  text: string
  exitCode: number
  iterations: number
  sessionId?: string
  resumed?: boolean
  runtimeRetries?: number
  /** Approval policy that was applied to this run. */
  approvalPolicy?: string
  /** Tools that the policy denied (with reason); useful for callers/tests. */
  approvalDenials?: Array<{ toolName: string; reason: string; bashRiskLevel?: string; bashRiskReasons?: string[] }>
}

/** Run a single-shot native conversation. */
export async function runHeadless(opts: HeadlessOptions): Promise<HeadlessResult> {
  const dispatcher = new ToolDispatcher()
  const toolDefs = buildNativeToolDefs(dispatcher)

  // Resolve resume session
  let resumed = false
  let resolvedSessionId: string | undefined
  let conversation = createConversation({
    system: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    model: opts.model,
    maxTokens: opts.maxTokens ?? 4096,
    tools: toolDefs,
  })

  if (opts.resumeSession) {
    let sessionId = opts.resumeSession
    if (sessionId === 'last') {
      const sessions = listSessions()
      sessionId = sessions[0]?.id ?? ''
    }
    if (sessionId) {
      const loaded = loadSession(sessionId)
      if (loaded) {
        // Restore the conversation from the saved session
        conversation.id = loaded.id
        conversation.model = loaded.model
        conversation.system = loaded.system ?? conversation.system
        conversation.maxTokens = loaded.maxTokens ?? conversation.maxTokens
        conversation.turns = [...loaded.turns]
        resolvedSessionId = loaded.id
        resumed = true
      }
    }
  }

  addUserMessage(conversation, opts.prompt)

  let streamedAny = false
  const toolCallLog: Array<{ tool: string; input: Record<string, unknown>; output: string }> = []
  const approvalDecisions: HeadlessApprovalRecord[] = []
  const autoApprove = opts.autoApprove === true
  const approvalPolicy = describeApprovalPolicy(autoApprove)

  // Headless installs its own onToolApproval callback unconditionally so the
  // conversation loop's per-tool approval gate fires. Without this, headless
  // mode would silently auto-execute every tool — see issue #1. The callback
  // denies unsafe tools (write/edit/NotebookEdit/bash) unless autoApprove
  // was explicitly requested via CLI/config; safe tools (read/glob/grep/…)
  // remain low-friction.
  const onToolApproval = buildHeadlessApprovalCallback({
    autoApprove,
    onDecision(record) {
      approvalDecisions.push(record)
      // Always surface denials on stderr — even in --json mode, since the
      // structured output is only printed after the loop completes and
      // operators reading logs deserve real-time visibility.
      if (!record.decision.allowed) {
        let detail = ''
        if ('bashRisk' in record.decision && record.decision.bashRisk) {
          const risk = record.decision.bashRisk
          detail = ` [risk=${risk.level}${risk.reasons[0] ? `: ${risk.reasons[0]}` : ''}]`
        }
        const msg = `Tool ${record.toolName} denied by headless approval policy (${approvalPolicy})${detail}. ` +
          `Re-run with --auto-approve to permit unsafe tools, or use the interactive REPL.`
        process.stderr.write(formatError(msg) + '\n')
      }
    },
  })

  const callbacks: ConversationCallbacks = opts.json
    ? {
        onToolApproval,
        onToolStart(name, input) {
          toolCallLog.push({ tool: name, input, output: '' })
        },
        onToolEnd(_name, result) {
          if (toolCallLog.length > 0) {
            toolCallLog[toolCallLog.length - 1]!.output = result
          }
        },
      }
    : (() => {
        const md = new StreamingMarkdownRenderer()
        return {
          onToolApproval,
          onText(text: string) {
            const rendered = md.push(text)
            if (rendered) {
              process.stdout.write(rendered)
              streamedAny = true
            }
          },
          onToolStart(name: string, input: Record<string, unknown>) {
            const flushed = md.flush()
            if (flushed) {
              process.stdout.write(flushed)
              streamedAny = true
            }
            process.stderr.write(formatToolStart(name, input) + '\n')
          },
          onToolEnd(name: string, result: string, isError: boolean, durationMs: number) {
            process.stderr.write(formatToolEnd(name, result, isError, durationMs) + '\n')
          },
          onError(error: string) {
            process.stderr.write(formatError(error) + '\n')
          },
          _flush() {
            const flushed = md.flush()
            if (flushed) {
              process.stdout.write(flushed)
              streamedAny = true
            }
          },
        } satisfies ConversationCallbacks & { _flush: () => void }
      })()

  const loopOpts: ConversationLoopOptions = {
    apiBaseUrl: opts.apiBaseUrl,
    apiKey: opts.apiKey,
    callbacks,
  }

  try {
    const maxRuntimeRetries = resolveRuntimeResumeRetries()
    let runtimeRetries = 0
    let totalIterations = 0

    while (true) {
      const {
        finalText,
        iterations,
        runtimeFailure,
      } = await runConversationLoop(
        conversation,
        dispatcher,
        loopOpts,
      )

      totalIterations += iterations

      if (!runtimeFailure) {
        const sessionId = resolvedSessionId ?? conversation.id

        // Save session after completion
        try {
          saveSession(conversation)
        } catch { /* non-fatal */ }

        if (opts.json) {
          const output = JSON.stringify({
            text: finalText,
            model: conversation.model,
            session_id: sessionId,
            resumed,
            exit_code: 0,
            tool_calls: toolCallLog,
            iterations: totalIterations,
            runtime_retries: runtimeRetries,
            approval_policy: approvalPolicy,
            approval_denials: serializeDenials(approvalDecisions),
          })
          process.stdout.write(output + '\n')
        } else {
          if ('_flush' in callbacks && typeof callbacks._flush === 'function') {
            (callbacks as any)._flush()
          }
          if (!streamedAny && finalText) {
            process.stdout.write(finalText)
          }
          if (finalText || streamedAny) {
            process.stdout.write('\n')
          }
        }

        return {
          text: finalText,
          exitCode: 0,
          iterations: totalIterations,
          sessionId,
          resumed,
          runtimeRetries,
          approvalPolicy,
          approvalDenials: serializeDenials(approvalDecisions),
        }
      }

      const sessionId = resolvedSessionId ?? conversation.id

      // Save after every runtime failure so a process crash can still resume
      // from the last well-formed transcript instead of losing tool results.
      try {
        saveSession(conversation)
      } catch { /* non-fatal */ }

      if (!runtimeFailure.retryable || runtimeRetries >= maxRuntimeRetries) {
        const exhausted = runtimeFailure.retryable && runtimeRetries >= maxRuntimeRetries
        const message = exhausted
          ? `${runtimeFailure.message} Runtime resume retries exhausted (${runtimeRetries}/${formatRuntimeRetryLimit(maxRuntimeRetries)}). Session preserved: ${sessionId}`
          : runtimeFailure.message
        if (opts.json) {
          const output = JSON.stringify({
            text: '',
            model: conversation.model,
            session_id: sessionId,
            resumed,
            exit_code: 1,
            tool_calls: toolCallLog,
            iterations: totalIterations,
            runtime_retries: runtimeRetries,
            runtime_failure: runtimeFailure,
            error: message,
            approval_policy: approvalPolicy,
            approval_denials: serializeDenials(approvalDecisions),
          })
          process.stdout.write(output + '\n')
        } else {
          process.stderr.write(formatError(message) + '\n')
        }
        return {
          text: '',
          exitCode: 1,
          iterations: totalIterations,
          sessionId,
          resumed,
          runtimeRetries,
          approvalPolicy,
          approvalDenials: serializeDenials(approvalDecisions),
        }
      }

      runtimeRetries++
      const delayMs = runtimeResumeDelayMs(runtimeRetries)
      const maxLabel = formatRuntimeRetryLimit(maxRuntimeRetries)
      process.stderr.write(`${ansi.dim}${
        `  ↻ Runtime failure is retryable; session ${sessionId} preserved. Continuing automatically ` +
        `(${runtimeRetries}/${maxLabel})${delayMs > 0 ? ` after ${delayMs}ms` : ''}…`
      }${ansi.reset}\n`)
      if (delayMs > 0) {
        await sleep(delayMs)
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const sessionId = resolvedSessionId ?? conversation.id

    // Still save what we have on error
    try { saveSession(conversation) } catch { /* non-fatal */ }

    if (opts.json) {
      const output = JSON.stringify({
        text: '',
        model: conversation.model,
        session_id: sessionId,
        resumed,
        exit_code: 1,
        tool_calls: toolCallLog,
        error: msg,
        approval_policy: approvalPolicy,
        approval_denials: serializeDenials(approvalDecisions),
      })
      process.stdout.write(output + '\n')
    } else {
      process.stderr.write(formatError(msg) + '\n')
    }

    return {
      text: '',
      exitCode: 1,
      iterations: 0,
      sessionId,
      resumed,
      approvalPolicy,
      approvalDenials: serializeDenials(approvalDecisions),
    }
  }
}

function serializeDenials(records: HeadlessApprovalRecord[]): Array<{ toolName: string; reason: string; bashRiskLevel?: string; bashRiskReasons?: string[] }> {
  return records
    .filter(r => !r.decision.allowed)
    .map(r => {
      const out: { toolName: string; reason: string; bashRiskLevel?: string; bashRiskReasons?: string[] } = {
        toolName: r.toolName,
        reason: r.decision.reason,
      }
      // Bash denials carry the structured classifier output so an operator
      // reading the JSON log can see WHY the bash command was rejected
      // (e.g. "git push --force") without having to re-classify.
      if ('bashRisk' in r.decision && r.decision.bashRisk) {
        out.bashRiskLevel = r.decision.bashRisk.level
        out.bashRiskReasons = r.decision.bashRisk.reasons
      }
      return out
    })
}

function resolveRuntimeResumeRetries(): number {
  const raw = process.env['OWLCODA_HEADLESS_RUNTIME_RESUME_RETRIES']
  if (!raw) return DEFAULT_RUNTIME_RESUME_RETRIES
  const value = raw.trim().toLowerCase()
  if (value === 'unlimited' || value === 'infinite' || value === 'inf') {
    return Number.POSITIVE_INFINITY
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_RUNTIME_RESUME_RETRIES
  return parsed
}

function runtimeResumeDelayMs(attempt: number): number {
  const raw = process.env['OWLCODA_HEADLESS_RUNTIME_RESUME_RETRY_DELAY_MS']
  const base = raw !== undefined && raw !== ''
    ? Number.parseInt(raw, 10)
    : DEFAULT_RUNTIME_RESUME_RETRY_DELAY_MS
  const safeBase = Number.isFinite(base) && base >= 0 ? base : DEFAULT_RUNTIME_RESUME_RETRY_DELAY_MS
  return Math.min(safeBase * Math.max(1, 2 ** (attempt - 1)), MAX_RUNTIME_RESUME_RETRY_DELAY_MS)
}

function formatRuntimeRetryLimit(limit: number): string {
  return Number.isFinite(limit) ? String(limit) : 'unlimited'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
