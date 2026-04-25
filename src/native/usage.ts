/**
 * OwlCoda Native Token/Usage Tracker
 *
 * Tracks token usage across conversation turns.
 * Uses the heuristic estimator (chars/4) since local models
 * may not report usage in the Anthropic format.
 */

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  requestCount?: number
}

export interface UsageSnapshot {
  /** Cumulative input tokens across all turns */
  totalInputTokens: number
  /** Cumulative output tokens across all turns */
  totalOutputTokens: number
  /** Number of API calls made */
  requestCount: number
  /** Total tokens (input + output) */
  totalTokens: number
  /** Estimated cost in USD (fictional — local models are free) */
  estimatedCostUsd: number
  /** Time of first request */
  startedAt: number | null
  /** Elapsed time in ms since first request */
  elapsedMs: number
}

/** Heuristic token estimation: ~4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Estimate tokens for a conversation's full context. */
export function estimateConversationTokens(conversation: {
  system: string
  turns: Array<{ content: unknown[] }>
}): { systemTokens: number; turnTokens: number; totalTokens: number } {
  const systemTokens = estimateTokens(conversation.system)
  let turnTokens = 0

  for (const turn of conversation.turns) {
    for (const block of turn.content) {
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') {
        turnTokens += estimateTokens(b.text)
      } else if (b.type === 'tool_result' && typeof b.content === 'string') {
        turnTokens += estimateTokens(b.content)
      } else if (b.type === 'tool_use' && b.input) {
        turnTokens += estimateTokens(JSON.stringify(b.input))
      }
    }
  }

  return { systemTokens, turnTokens, totalTokens: systemTokens + turnTokens }
}

/** Format context budget display. */
export function formatBudget(
  usedTokens: number,
  contextWindow: number,
): string {
  const pct = contextWindow > 0 ? ((usedTokens / contextWindow) * 100).toFixed(1) : '?'
  const bar = contextWindow > 0 ? progressBar(usedTokens / contextWindow, 20) : '???'
  return [
    `Context: ${usedTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens (${pct}%)`,
    `  ${bar}`,
    usedTokens > contextWindow * 0.8
      ? '  ⚠ High context usage — consider /compact to free space'
      : '',
  ].filter(Boolean).join('\n')
}

function progressBar(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio))
  const filled = Math.round(clamped * width)
  const empty = width - filled
  const color = clamped > 0.8 ? '\x1b[31m' : clamped > 0.5 ? '\x1b[33m' : '\x1b[32m'
  return `${color}${'█'.repeat(filled)}${'░'.repeat(empty)}\x1b[0m`
}

/**
 * Usage tracker accumulates token counts across conversation turns.
 */
export class UsageTracker {
  private inputTokens = 0
  private outputTokens = 0
  private requestCount = 0
  private startedAt: number | null = null

  /** Record usage from one API response. */
  recordUsage(usage: TokenUsage): void {
    if (!this.startedAt) {
      this.startedAt = Date.now()
    }
    this.inputTokens += usage.inputTokens
    this.outputTokens += usage.outputTokens
    this.requestCount += usage.requestCount ?? 1
  }

  /** Record usage by estimating from text content. */
  recordEstimated(inputText: string, outputText: string): void {
    this.recordUsage({
      inputTokens: estimateTokens(inputText),
      outputTokens: estimateTokens(outputText),
    })
  }

  /** Get current usage snapshot. */
  getSnapshot(): UsageSnapshot {
    const totalTokens = this.inputTokens + this.outputTokens
    return {
      totalInputTokens: this.inputTokens,
      totalOutputTokens: this.outputTokens,
      requestCount: this.requestCount,
      totalTokens,
      // Fictional pricing: $0.003/1K input, $0.015/1K output (like Sonnet 4)
      estimatedCostUsd: (this.inputTokens * 0.003 + this.outputTokens * 0.015) / 1000,
      startedAt: this.startedAt,
      elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
    }
  }

  /** Reset all counters. */
  reset(): void {
    this.inputTokens = 0
    this.outputTokens = 0
    this.requestCount = 0
    this.startedAt = null
  }

  /** Format usage for display. */
  formatUsage(): string {
    const snap = this.getSnapshot()
    const lines = [
      `Tokens: ${snap.totalInputTokens.toLocaleString()} in / ${snap.totalOutputTokens.toLocaleString()} out (${snap.totalTokens.toLocaleString()} total)`,
      `Requests: ${snap.requestCount}`,
    ]

    if (snap.elapsedMs > 0) {
      const secs = (snap.elapsedMs / 1000).toFixed(1)
      lines.push(`Duration: ${secs}s`)
    }

    // Estimated cost (fictional for local models)
    lines.push(`Est. cost: $${snap.estimatedCostUsd.toFixed(4)} (fictional — local models are free)`)

    return lines.join('\n')
  }
}
