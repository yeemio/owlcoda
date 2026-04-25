/**
 * OwlCoda Native Agent Tool
 *
 * Spawns a sub-conversation (sub-agent) with its own tool dispatcher.
 * The sub-agent runs the prompt to completion and returns the result.
 *
 * Supports agent types:
 *   - "general-purpose" (default): all tools available
 *   - "Explore": read-only subset (bash, read, glob, grep)
 */

import { randomUUID } from 'node:crypto'
import type { Conversation } from '../protocol/types.js'
import { ProviderRequestError, formatProviderDiagnostic } from '../../provider-error.js'
import type { NativeToolDef, ToolResult } from './types.js'
import {
  createConversation,
  addUserMessage,
  runConversationLoop,
  type ConversationLoopOptions,
  type ConversationCallbacks,
} from '../conversation.js'
import { ToolDispatcher } from '../dispatch.js'
import { buildNativeToolDefs } from '../tool-defs.js'
import { buildSystemPrompt } from '../system-prompt.js'

export interface AgentInput {
  /** Short 3-5 word description of the task */
  description: string
  /** The full task prompt for the sub-agent */
  prompt: string
  /** Agent type: "general-purpose" or "Explore" */
  subagent_type?: string
}

/** Read-only tools for Explore agent */
const EXPLORE_TOOLS = new Set(['bash', 'read', 'glob', 'grep', 'WebFetch', 'WebSearch'])

function getExploreSystemPrompt(): string {
  return `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from:
- Creating new files
- Modifying existing files
- Deleting files

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use glob for broad file pattern matching
- Use grep for searching file contents with regex
- Use read when you know the specific file path
- Use bash ONLY for read-only operations (ls, git status, git log, git diff, find, cat, head, tail)
- NEVER use bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, or any modification

Complete the search request efficiently and report your findings clearly.`
}

/** Sub-agents indexed by their run ID for status queries */
const runningAgents = new Map<string, { description: string; startTime: number }>()

export function getRunningAgents(): Map<string, { description: string; startTime: number }> {
  return runningAgents
}

export interface AgentToolDeps {
  /** API base URL for sub-agent requests */
  apiBaseUrl: string
  /** API key */
  apiKey: string
  /** Model to use for sub-agent */
  model: string
  /** Resolve the latest active model at execution time. */
  getModel?: () => string
  /** Max tokens per response */
  maxTokens: number
  /** Optional callbacks for sub-agent output */
  callbacks?: ConversationCallbacks
  /** Context window size */
  contextWindow?: number
}

export function createAgentTool(deps: AgentToolDeps): NativeToolDef<AgentInput> {
  return {
    name: 'Agent',
    description:
      'Launch a sub-agent to handle a specific task. The sub-agent runs in its own conversation context with access to tools. Use for delegating independent subtasks.',

    async execute(input: AgentInput): Promise<ToolResult> {
      const { description, prompt, subagent_type } = input

      if (!prompt || typeof prompt !== 'string') {
        return { output: 'Error: prompt is required', isError: true }
      }
      if (!description || typeof description !== 'string') {
        return { output: 'Error: description is required', isError: true }
      }

      const agentType = subagent_type ?? 'general-purpose'
      const agentId = `agent-${randomUUID().slice(0, 8)}`
      const isExplore = agentType.toLowerCase() === 'explore'
      const activeModel = deps.getModel ? deps.getModel() : deps.model

      // Create sub-agent dispatcher
      const subDispatcher = new ToolDispatcher()

      // For Explore, remove write/edit tools
      if (isExplore) {
        const names = subDispatcher.getToolNames()
        for (const name of names) {
          if (!EXPLORE_TOOLS.has(name)) {
            subDispatcher.unregister(name)
          }
        }
      }

      // Build system prompt
      const systemPrompt = isExplore ? getExploreSystemPrompt() : buildSystemPrompt()

      // Create sub-conversation
      const subConv = createConversation({
        system: systemPrompt,
        model: activeModel,
        maxTokens: deps.maxTokens,
        tools: buildNativeToolDefs(subDispatcher),
      })

      addUserMessage(subConv, prompt)

      // Track this agent
      runningAgents.set(agentId, { description, startTime: Date.now() })

      // Wrap callbacks to prefix with agent label
      const label = `[${agentType}:${agentId}]`
      const wrappedCallbacks: ConversationCallbacks = {
        onText: (text) => deps.callbacks?.onText?.(`${label} ${text}`),
        onToolStart: (name, inp) => deps.callbacks?.onToolStart?.(name, inp),
        onToolEnd: (name, result, isErr, dur) => deps.callbacks?.onToolEnd?.(name, result, isErr, dur),
        onError: (err) => deps.callbacks?.onError?.(`${label} ${err}`),
      }

      const loopOpts: ConversationLoopOptions = {
        apiBaseUrl: deps.apiBaseUrl,
        apiKey: deps.apiKey,
        maxIterations: isExplore ? 15 : 25,
        callbacks: wrappedCallbacks,
        contextWindow: deps.contextWindow,
      }

      try {
        const result = await runConversationLoop(subConv, subDispatcher, loopOpts)

        const elapsed = ((Date.now() - runningAgents.get(agentId)!.startTime) / 1000).toFixed(1)
        runningAgents.delete(agentId)

        if (result.runtimeFailure) {
          return {
            output: `Agent error: ${result.runtimeFailure.message}`,
            isError: true,
            metadata: {
              agentId,
              agentType,
              iterations: result.iterations,
              stopReason: result.stopReason,
              usage: result.usage,
              elapsedSeconds: parseFloat(elapsed),
              runtimeFailure: result.runtimeFailure,
            },
          }
        }

        // If the subagent finished without a final message (hit iteration cap,
        // tool_use stop with no follow-up text, streaming glitch, etc.), we
        // synthesise a useful summary from what DID happen — tools it called,
        // last non-empty assistant text it produced, stop reason, iteration
        // count. A black-box "(Agent completed with no text output)" is a
        // trust killer for long runs, so this fallback is always non-empty
        // when the loop returned without throwing.
        const output = result.finalText.trim().length > 0
          ? result.finalText
          : summarizeSilentAgent(subConv, result.iterations, result.stopReason, parseFloat(elapsed))

        return {
          output,
          isError: false,
          metadata: {
            agentId,
            agentType,
            iterations: result.iterations,
            stopReason: result.stopReason,
            usage: result.usage,
            elapsedSeconds: parseFloat(elapsed),
            silent: result.finalText.trim().length === 0,
          },
        }
      } catch (err: unknown) {
        runningAgents.delete(agentId)
        // Abort stays distinct from provider failure — user cancelled, not
        // a network/upstream problem.
        if (err instanceof Error && (err.name === 'AbortError' || err.message === 'This operation was aborted')) {
          return {
            output: 'Agent cancelled',
            isError: true,
            metadata: { agentId, agentType, cancelled: true },
          }
        }
        // Structured provider errors pass through their formatted form so the
        // headline/provider/request-id stays visible.
        if (err instanceof ProviderRequestError) {
          return {
            output: `Agent error: ${formatProviderDiagnostic(err.diagnostic, { includeRequestId: true })}`,
            isError: true,
            metadata: { agentId, agentType, diagnostic: err.diagnostic },
          }
        }
        const msg = err instanceof Error ? err.message : String(err)
        return {
          output: `Agent error: ${msg}`,
          isError: true,
          metadata: { agentId, agentType },
        }
      }
    },
  }
}


/**
 * Build a meaningful summary when a sub-agent returned without a final text
 * message. Walks the sub-conversation to surface tools used, the last
 * non-empty assistant text (often the agent describing what it did before
 * running out of iterations), and key metrics. Never returns an empty string.
 */
export function summarizeSilentAgent(
  subConv: Conversation,
  iterations: number,
  stopReason: string | null,
  elapsedSeconds: number,
): string {
  const toolCounts = new Map<string, number>()
  const assistantTexts: string[] = []

  for (const turn of subConv.turns) {
    if (turn.role !== 'assistant') continue
    for (const block of turn.content) {
      if (block.type === 'text' && typeof (block as { text?: string }).text === 'string') {
        const t = (block as { text: string }).text.trim()
        if (t.length > 0) assistantTexts.push(t)
      } else if (block.type === 'tool_use') {
        const name = (block as { name?: string }).name ?? '?'
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1)
      }
    }
  }

  const parts: string[] = []
  parts.push(
    `(Agent finished without a final message — ${iterations} iteration${iterations === 1 ? '' : 's'}, ` +
    `stop_reason=${stopReason ?? 'none'}, ${elapsedSeconds.toFixed(1)}s.)`,
  )

  if (toolCounts.size > 0) {
    const toolSummary = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => (n === 1 ? name : `${name} (${n}x)`))
      .join(', ')
    parts.push(`Tools used: ${toolSummary}.`)
  } else {
    parts.push('No tools were used.')
  }

  if (assistantTexts.length > 0) {
    const last = assistantTexts[assistantTexts.length - 1]!
    const snippet = last.length > 400 ? last.slice(0, 400).trimEnd() + '…' : last
    parts.push(`Last assistant text:\n${snippet}`)
  } else {
    parts.push('The agent produced no assistant text during this run.')
  }

  parts.push('If the result is genuinely silent-but-useful (e.g. files were written), check side effects directly.')
  return parts.join('\n\n')
}
