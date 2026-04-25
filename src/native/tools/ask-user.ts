/**
 * OwlCoda Native AskUserQuestion Tool
 *
 * Prefers the host UI callback (context.askUserQuestion). When absent,
 * falls back to a readline prompt on stdin/stdout — only safe in
 * headless / non-interactive modes because direct stdout writes race
 * Ink's frame paint (see memory/feedback_ink_side_channel_stdout_race.md).
 */

import * as readline from 'node:readline'
import type { AskUserOption, NativeToolDef, ToolExecutionContext, ToolResult } from './types.js'

export interface AskUserQuestionInput {
  question: string
  options?: Array<AskUserOption>
  /** Allow multiple selections */
  multiSelect?: boolean
}

/**
 * Build a ToolResult from the user's raw answer. Shared between the
 * in-Ink overlay path and the headless readline fallback so the two
 * paths return identically-shaped results for the model.
 *
 * Empty answer is treated as a cancellation marker (the overlay
 * resolves empty on Ctrl+C). Numeric-only answers are resolved
 * against `options` as 1-based indices, matching the legacy
 * readline prompt behavior.
 */
function formatAnswer(
  answer: string,
  options: Array<AskUserOption> | undefined,
): ToolResult {
  if (!answer) {
    return {
      output: 'User cancelled the question.',
      isError: false,
      metadata: { cancelled: true },
    }
  }

  if (options && /^\d+([,\s]+\d+)*$/.test(answer)) {
    const indices = answer.split(/[,\s]+/).map((n) => parseInt(n, 10) - 1)
    const selected = indices
      .filter((i) => i >= 0 && i < options.length)
      .map((i) => options[i]!.label)
    if (selected.length > 0) {
      return {
        output: `User selected: ${selected.join(', ')}`,
        isError: false,
        metadata: { selected },
      }
    }
  }

  return {
    output: `User response: ${answer}`,
    isError: false,
    metadata: { answer },
  }
}

/**
 * Timeout before a headless AskUserQuestion call auto-cancels. Five
 * minutes is long enough for a real "stop and think" pause but short
 * enough that an abandoned background agent won't wedge its turn
 * forever. Overridable via OWLCODA_ASK_USER_TIMEOUT_MS for CI runs
 * that intentionally block on input.
 */
function resolveAskUserTimeoutMs(): number {
  const raw = (process.env['OWLCODA_ASK_USER_TIMEOUT_MS'] ?? '').trim()
  if (raw.toLowerCase() === 'unlimited' || raw === '0' || raw === '-1') {
    return Number.POSITIVE_INFINITY
  }
  const parsed = Number.parseInt(raw, 10)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return 5 * 60 * 1000
}

async function promptUserFallback(
  question: string,
  options: Array<AskUserOption> | undefined,
  multiSelect: boolean | undefined,
): Promise<string> {
  const lines: string[] = ['', `📋 ${question}`, '']
  if (options && options.length > 0) {
    for (let i = 0; i < options.length; i++) {
      const opt = options[i]!
      lines.push(`  ${i + 1}) ${opt.label}`)
      if (opt.description) {
        lines.push(`     ${opt.description}`)
      }
    }
    lines.push('')
    if (multiSelect) {
      lines.push('Enter numbers separated by commas, or type your answer: ')
    } else {
      lines.push('Enter number or type your answer: ')
    }
  }
  process.stdout.write(lines.join('\n'))

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  const timeoutMs = resolveAskUserTimeoutMs()
  try {
    return await new Promise<string>((resolve) => {
      // Fallback path used to hang forever if stdin was closed or the
      // operator walked away. Auto-resolve after timeoutMs with empty
      // string — formatAnswer() maps that to a clean "User cancelled"
      // marker, so the model can move on instead of wedging the turn.
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (answer: string): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(answer)
      }
      if (Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          process.stdout.write(`\n(no input received for ${Math.round(timeoutMs / 1000)}s — treating as cancelled)\n`)
          finish('')
        }, timeoutMs)
      }
      rl.question(options ? '> ' : '> ', (answer) => {
        finish(answer.trim())
      })
    })
  } finally {
    rl.close()
  }
}

export function createAskUserQuestionTool(): NativeToolDef<AskUserQuestionInput> {
  return {
    name: 'AskUserQuestion',
    description:
      'Ask the user a question to gather information, clarify ambiguity, or get decisions on implementation choices.',

    async execute(
      input: AskUserQuestionInput,
      context?: ToolExecutionContext,
    ): Promise<ToolResult> {
      const { question, options, multiSelect } = input

      if (!question || typeof question !== 'string') {
        return { output: 'Error: question is required', isError: true }
      }

      // Preferred path: route through the host UI callback. No stdout
      // write from this tool — the Ink overlay handles display and
      // input, and returns the raw answer. This keeps the per-frame
      // "one writeDiffToTerminal only" invariant intact.
      if (context?.askUserQuestion) {
        try {
          const answer = await context.askUserQuestion(question, { options, multiSelect })
          return formatAnswer(answer, options)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { output: `Error asking user: ${msg}`, isError: true }
        }
      }

      // Headless fallback: the host has no interactive surface, so
      // there's no Ink frame to race. Safe to write stdout directly.
      const answer = await promptUserFallback(question, options, multiSelect)
      return formatAnswer(answer, options)
    },
  }
}
