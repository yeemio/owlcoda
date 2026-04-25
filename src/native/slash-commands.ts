/**
 * OwlCoda Slash Command Handlers
 *
 * Extracted from repl.ts for maintainability. Contains the handleSlashCommand
 * dispatch function and its direct helpers (safeRender, rebuildSystemPrompt).
 *
 * All slash commands (/help, /model, /save, /search, etc.) are handled here.
 */

import * as readline from "node:readline"
import { writeFileSync, readFileSync, existsSync, statSync, readdirSync } from "node:fs"
import { execSync } from "node:child_process"
import { join, resolve, dirname, basename } from "node:path"
import { homedir } from "node:os"
import { ToolDispatcher } from "./dispatch.js"
import { MCPManager } from "./mcp/manager.js"
import { runConversationLoop, shouldShowNoResponseFallback } from "./conversation.js"
import type { Conversation } from "./protocol/types.js"
import { sanitizeConversationTurns } from "./protocol/request.js"
import { buildNativeToolDefs } from "./tool-defs.js"
import { buildSystemPrompt } from "./system-prompt.js"
import { formatError, formatUsage, ansi } from "./display.js"
import {
  PersistentStatusBar,
  ToolResultCollector,
  sgr, themeColor, dim,
  THEME_NAMES, setTheme, getThemeName,
  showPicker,
  renderMcpPanel,
  renderSessionInfoPanel,
  renderSessionsPanel,
  renderSettingsPanel,
  type ThemeName,
  type PickerItem,
} from "./tui/index.js"
import { StreamingMarkdownRenderer } from "./markdown.js"
import { VERSION } from "../version.js"
import { UsageTracker, estimateTokens, estimateConversationTokens, formatBudget } from "./usage.js"
import { saveSession, loadSession, listSessions, restoreConversation, deleteSession } from "./session.js"
import { CAPABILITIES } from "../capabilities.js"
import { isTraceEnabled, setTraceEnabled } from "../trace.js"
import { getRecentErrors, getUptime, getErrorCount } from "../diagnostics.js"
import { getMetrics } from "../observability.js"
import { getRateLimitStats } from "../middleware/rate-limit.js"
import { formatProviderDiagnostic, parseProviderDiagnosticFromPayload, parseProviderDiagnosticFromString } from "../provider-error.js"
import { getAllCircuitStates, resetCircuitBreaker } from "../middleware/circuit-breaker.js"
import { readAuditLog } from "../audit.js"
import { getAllBudgets, getSloTarget, resetBudgets } from "../error-budget.js"
import { getRecentTraces } from "../request-trace.js"
import { getNuclearClearSequence } from "../ink/clearTerminal.js"
import { renderMetrics } from "../prometheus.js"
import { formatAllPerfSummaries } from "../perf-tracker.js"
import { getLoadedPlugins, loadPlugins } from "../plugins/index.js"
import { discoverBackends } from "../backends/discovery.js"
import { warmupModels, formatWarmupResults } from "../warmup.js"
import { recommendModel, formatRecommendation, type Intent } from "../model-recommender.js"
import { loadConfig, resolveModelContextWindow } from "../config.js"
import {
  branchSession, listBranches,
  addSessionTag, removeSessionTag, getSessionTags, findSessionsByTag,
  trimSessionTurns, compressSessionWithLLM as compressSessionNative,
  saveSession as autoSaveSession,
} from "./session.js"
import { createAgentTool } from "./tools/agent.js"
import { getOwlcodaConfigPath, getOwlcodaDirLabel } from "../paths.js"
import { loadPermissions, addGlobalPermission, clearGlobalPermissions } from "./permissions.js"
import { probeRuntimeSurface } from "../runtime-probe.js"
import { isInteractiveChatModelName } from "../model-registry.js"
import { getTranscriptInteractionCapability } from "./repl-compat.js"
import { resolveLiveReplResumeTarget, updateLiveReplClientSession } from "../repl-lease.js"
import { ModelConfigMutator } from "../model-config-mutator.js"
import {
  adminAutoOpenDisabledHint,
  adminHandoffFailureHint,
  buildAdminHandoffUrl,
  createOneShotAdminToken,
  getAdminBearerToken,
  getAdminBundleStatus,
  openUrlInBrowser,
  shouldAutoOpenAdminBrowser,
  type AdminHandoffContext,
} from "../admin-delivery.js"

type AdminModelTruthSnapshot = {
  runtimeOk: boolean
  runtimeSource: string | null
  runtimeProbeDetail: string
  runtimeModelCount: number
  statuses: Array<{
    id: string
    label: string
    providerKind: 'local' | 'cloud' | 'unknown'
    presentIn: {
      config: boolean
      router: boolean
      discovered: boolean
      catalog: boolean
    }
    availability: {
      kind: string
      envName?: string
      reason?: string
      with?: string
    }
    raw: {
      config?: {
        id: string
        endpoint?: string
        apiKey?: string
        apiKeyEnv?: string
      }
      discovered?: {
        backend?: string
        baseUrl?: string
        parameterSize?: string
        quantization?: string
        contextWindow?: number
      }
    }
  }>
}

export interface ReplOptions {
  apiBaseUrl: string
  apiKey: string
  model: string
  maxTokens?: number
  systemPrompt?: string
  resumeSession?: string
  liveReplClientId?: string
  liveReplRuntime?: {
    host: string
    port: number
    routerUrl: string
    runtimeToken: string
  }
}

async function openAdminHandoffFromSlash(
  context: AdminHandoffContext,
  opts?: ReplOptions,
  handoffOptions: { explicitOpen?: boolean, suppressSuccessOutput?: boolean } = {},
): Promise<void> {
  if (!opts?.apiBaseUrl) {
    console.log(`${ansi.dim}Browser handoff unavailable: no API base URL in this context.${ansi.reset}`)
    return
  }

  const config = loadConfig()
  const token = createOneShotAdminToken(getAdminBearerToken(config))
  const url = buildAdminHandoffUrl(opts.apiBaseUrl, token, context)
  const shouldOpenBrowser = handoffOptions.explicitOpen || shouldAutoOpenAdminBrowser()

  if (shouldOpenBrowser) {
    const bundle = getAdminBundleStatus()

    if (!bundle.available) {
      console.log(`${ansi.dim}Admin bundle is not built yet: expected ${bundle.indexPath}${ansi.reset}`)
      console.log(`${ansi.dim}The server will show a friendly bundle-missing page until the browser bundle exists.${ansi.reset}`)
    }

    if (bundle.available) {
      const opened = openUrlInBrowser(url)
      if (opened) {
        if (!handoffOptions.suppressSuccessOutput) {
          console.log(`${ansi.green}Opened browser admin.${ansi.reset}`)
        }
        if (handoffOptions.suppressSuccessOutput) {
          return
        }
      } else {
        console.log(`${ansi.dim}Could not open a browser automatically.${ansi.reset}`)
      }
    } else {
      console.log(`${ansi.dim}Skipping automatic browser open because the admin bundle is missing.${ansi.reset}`)
    }
  } else {
    console.log(`${ansi.dim}${adminAutoOpenDisabledHint()}${ansi.reset}`)
  }

  console.log(`Admin URL: ${url}`)
  console.log(`${ansi.dim}${adminHandoffFailureHint()}${ansi.reset}`)
}

export interface ApproveState {
  autoApprove: boolean
}

export interface ThinkingState {
  mode: "collapsed" | "verbose"
  lastThinking: string
}

export interface SlashCommandOutput {
  write?: (text: string, options?: { transient?: boolean }) => void
  clearTransient?: () => void
}

function writeSlashOutput(
  output: SlashCommandOutput | undefined,
  text: string,
  options?: { transient?: boolean },
): void {
  if (output?.write) {
    output.write(text, options)
    return
  }
  process.stdout.write(text)
}

function clearSlashTransient(output: SlashCommandOutput | undefined): void {
  if (output?.clearTransient) {
    output.clearTransient()
    return
  }
  process.stdout.write('\r\x1b[K')
}

async function fetchAdminModelTruth(
  opts: ReplOptions,
  options: { skipCache?: boolean } = {},
): Promise<AdminModelTruthSnapshot> {
  const url = new URL('/admin/model-truth', opts.apiBaseUrl)
  if (options.skipCache) {
    url.searchParams.set('skipCache', 'true')
  }
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
    },
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) {
    throw new Error(`admin model truth request failed (${res.status})`)
  }
  return res.json() as Promise<AdminModelTruthSnapshot>
}

/**
 * Error boundary for TUI rendering — prevents crashes from bad ANSI/markdown.
 * Falls back to raw text on error.
 */
export function safeRender(fn: () => string, fallback = ""): string {
  try {
    return fn()
  } catch (err) {
    if (isTraceEnabled()) {
      console.error(dim("[render error] " + (err instanceof Error ? err.message : String(err))))
    }
    return fallback
  }
}

/** Rebuild system prompt with current mode flags and update conversation. */
function rebuildSystemPrompt(conversation: Conversation): void {
  conversation.system = buildSystemPrompt({
    modes: {
      brief: conversation.options?.brief,
      fast: conversation.options?.fast,
      effort: conversation.options?.effort as "low" | "medium" | "high" | undefined,
    },
  })
}

/** All known slash commands — shared with repl.ts for tab completion. */
export const SLASH_COMMANDS = [
  "/help", "/model", "/clear", "/compact", "/budget",
  "/save", "/sessions", "/turns", "/cost", "/tokens",
  "/status", "/settings", "/config", "/capabilities", "/doctor", "/trace",
  "/session", "/resume", "/history", "/export",
  "/dashboard", "/audit", "/health", "/ratelimit", "/slo",
  "/traces", "/perf", "/metrics", "/reset-circuits", "/reset-budgets",
  "/backends", "/recommend", "/warmup", "/plugins", "/models",
  "/why-native",
  "/approve", "/branch", "/branches", "/tag", "/compress",
  "/theme", "/themes", "/thinking", "/undo", "/retry", "/rewind", "/context",
  "/plan", "/permissions", "/diff", "/memory", "/rename",
  "/init", "/verbose", "/quit", "/exit",
  "/version", "/files", "/stats", "/brief", "/fast", "/effort",
  "/color", "/vim", "/btw", "/commit", "/release-notes",
  "/skills", "/tasks", "/mcp", "/hooks", "/pr-comments",
  "/review", "/add-dir", "/login", "/search", "/editor",
]

function friendlyStatus(status: number): string {
  const names: Record<number, string> = {
    400: 'Bad request',
    401: 'Authentication failed',
    403: 'Forbidden',
    404: 'Not found',
    408: 'Request timeout',
    429: 'Rate limited — too many requests',
    499: 'Request cancelled',
    500: 'Internal server error',
    502: 'Bad gateway',
    503: 'Service unavailable',
    529: 'Backend overloaded — no models available',
  }
  return names[status] ?? `HTTP ${status}`
}

/**
 * Parse raw API error strings into user-friendly messages.
 * Handles JSON error bodies, HTTP status codes, SSL errors,
 * and other common patterns.
 */
export function parseApiError(raw: string): string {
  const parsedDiagnostic = parseProviderDiagnosticFromString(raw)
  if (parsedDiagnostic) {
    return formatProviderDiagnostic(parsedDiagnostic, { includeRequestId: true })
  }

  if (raw.includes('ETIMEDOUT')) {
    return 'Request timed out. Check your internet connection and proxy settings'
  }
  if (raw.includes('TimeoutError') || (raw.includes('aborted') && raw.includes('timeout'))) {
    return 'Request timed out. The model may be overloaded or slow to respond'
  }
  if (raw.includes('This operation was aborted') || raw.includes('Request aborted')) {
    return 'Request aborted before completion. Use /retry or /model to switch'
  }
  if (raw.includes('UNABLE_TO_VERIFY_LEAF_SIGNATURE') || raw.includes('UNABLE_TO_GET_ISSUER_CERT')) {
    return 'Unable to connect to API: SSL certificate verification failed. Check your proxy or corporate SSL certificates'
  }
  if (raw.includes('CERT_HAS_EXPIRED')) {
    return 'Unable to connect to API: SSL certificate has expired'
  }
  if (raw.includes('SELF_SIGNED_CERT_IN_CHAIN') || raw.includes('DEPTH_ZERO_SELF_SIGNED_CERT')) {
    return 'Unable to connect to API: Self-signed certificate detected. Check your proxy or corporate SSL certificates'
  }
  if (raw.includes('ERR_TLS_CERT_ALTNAME_INVALID') || raw.includes('HOSTNAME_MISMATCH')) {
    return 'Unable to connect to API: SSL certificate hostname mismatch'
  }
  if (raw === 'Connection error.' || raw.includes('ECONNREFUSED')) {
    return 'Unable to connect to API. Check your internet connection'
  }

  const statusMatch = raw.match(/API error (\d+):\s*(.*)/)
  if (statusMatch) {
    const status = parseInt(statusMatch[1]!, 10)
    const body = statusMatch[2]!.trim()
    try {
      const json = JSON.parse(body)
      const diagnostic = parseProviderDiagnosticFromPayload(json)
      if (diagnostic) {
        return formatProviderDiagnostic(diagnostic, { includeRequestId: true })
      }
      const msg = json.error?.message ?? json.message ?? json.error ?? null
      if (msg) {
        return `${friendlyStatus(status)}: ${msg}`
      }
    } catch { /* not JSON, continue */ }
    const short = body.length > 120 ? body.slice(0, 120) + '…' : body
    return `${friendlyStatus(status)}${short ? ': ' + short : ''}`
  }

  return raw.length > 200 ? raw.slice(0, 200) + '…' : raw
}

/** Handle slash commands. Returns true if handled. */
export async function handleSlashCommand(input: string, conversation: Conversation, usage: UsageTracker, opts?: ReplOptions, approveState?: ApproveState, dispatcher?: ToolDispatcher, statusBar?: PersistentStatusBar, toolCollector?: ToolResultCollector, rl?: readline.Interface, mcpManager?: MCPManager, thinkingState?: ThinkingState, output?: SlashCommandOutput): Promise<boolean> {
  const parts = input.split(/\s+/)
  const cmd = parts[0]!.toLowerCase()
  const arg = parts.slice(1).join(' ').trim()

  switch (cmd) {
    case '/help':
      if (arg) {
        // Searchable help — filter commands matching query
        const query = arg.toLowerCase()
        const matchingCmds = SLASH_COMMANDS.filter(c => c.toLowerCase().includes(query))
        if (matchingCmds.length === 0) {
          console.log(`${dim('No commands matching')} "${arg}"`)
        } else {
          console.log(`\n  ${themeColor('owl')}🦉 Commands matching "${arg}":${sgr.reset}\n`)
          for (const c of matchingCmds) {
            console.log(`    ${themeColor('owl')}${c}${sgr.reset}`)
          }
          console.log()
        }
      } else {
      const interaction = getTranscriptInteractionCapability()
      console.log(`
  ${themeColor('owl')}🦉 OwlCoda Commands${sgr.reset}

  ${sgr.bold}Chat & Model:${sgr.reset}
    /model [name]     Show or switch model
    /thinking [mode]  Extended thinking (on|off|verbose|show)
    /compact [N]      Keep only last N turns (LLM summary, default: 6)
    /clear            Clear conversation history
    /undo             Undo last exchange (remove last assistant response)
    /retry            Retry last message (undo + resend)
    /rewind [N]       Remove last N message exchanges
    /brief [on|off]   Toggle brief response mode
    /fast [on|off]    Toggle fast mode (speed over depth)
    /effort <level>   Set effort level (low|medium|high)
    /btw <question>   Side question without interrupting context

  ${sgr.bold}Session:${sgr.reset}
    /save [title]     Save current session
    /session          Show current session info
    /sessions         List/search/delete saved sessions
    /resume [id]      Resume a saved session
    /history [N]      Show conversation history
    /search <query>   Search within conversation
    /export [format]  Export (json|markdown)
    /rename <title>   Rename current session
    /branch [name]    Branch current session
    /branches         List session branches
    /tag <sub> <val>  Tag sessions (add|remove|list|search)
    /compress [opts]  Compress session (--trim N)

  ${sgr.bold}Configuration:${sgr.reset}
    /init             Create OWLCODA.md project instructions
    /theme [name]     Switch color theme (${THEME_NAMES.join(', ')})
    /color [name]     Alias for /theme
    /approve [on|off] Toggle auto-approve mode
    /verbose [on|off] Toggle verbose tool output
    /permissions      Show permission settings
    /settings         Show settings panel
    /memory           Show memory/context files
    /plan             Plan mode info
    /vim              Toggle vim keybindings
    /editor           Open $EDITOR for multi-line input
    /add-dir <path>   Add a working directory
    /login [model key] Manage cloud API keys

  ${sgr.bold}Diagnostics:${sgr.reset}
    /status           Show session status
    /config           Show runtime configuration
    /capabilities     Show capability labels
    /doctor           Run platform diagnostics
    /trace [on|off]   Toggle debug trace logging
    /diff [file]      Show recent file changes (detail view with file arg)
    /context          Show context window usage
    /version          Show version number
    /release-notes    Show release notes

  ${sgr.bold}Observability:${sgr.reset}
    /budget           Show context window usage
    /cost             Show token usage and estimated cost
    /tokens           Show token usage summary
    /stats            Show detailed session statistics
    /turns            Show turn count
    /files            List files referenced in context
    /dashboard        Show observability metrics
    /audit [N]        Show request audit log
    /health           Show model health + circuit breakers
    /ratelimit        Show per-model rate limits
    /slo              Show error budget / SLO status
    /traces [N]       Show request traces
    /perf             Show performance metrics
    /metrics          Show Prometheus-format metrics
    /reset-circuits   Reset all circuit breakers
    /reset-budgets    Reset all error budget windows

  ${sgr.bold}Git & Code:${sgr.reset}
    /commit [msg]     Show status or commit all changes
    /pr-comments <n>  View PR comments (needs gh CLI)
    /review           Review a pull request (needs gh CLI)

  ${sgr.bold}Models & Backends:${sgr.reset}
    /models [issues|overview|refresh]  Model workstation — Enter opens browser admin for the selection
    /models edit <id>     Open the selected model in browser admin
    /models browser [route] [id]  Open browser admin (route: models|aliases|orphans|catalog)
    /backends         Discover local LLM backends
    /recommend [intent] Recommend best model
    /warmup           Warm up backend models
    /plugins          List loaded plugins
    /skills           List available skills
    /tasks            List background tasks
    /mcp              Manage MCP servers
    /hooks            View hook configurations

  ${sgr.bold}About:${sgr.reset}
    /why-native       Learn what makes native mode special

  ${dim(`Interaction: ${interaction.helpSummary}`)}
  ${dim('Tip: Use /help <query> to search · Tab for completion · Ctrl+R to search history')}
`)
      }
      return true

    case '/model':
      if (arg) {
        conversation.model = arg
        console.log(`${themeColor('success')}✓ Switched to: ${sgr.bold}${arg}${sgr.reset}`)
        // Quick availability check against proxy
        if (opts) {
          try {
            const res = await fetch(`${opts.apiBaseUrl}/v1/models`, { signal: AbortSignal.timeout(3000) })
            if (res.ok) {
              const data = await res.json() as { data?: Array<{ id: string }> }
              const ids = (data.data ?? []).map(m => m.id)
              if (ids.length > 0 && !ids.includes(arg)) {
                console.log(dim(`  ⚠ "${arg}" not in proxy model list — may be a cloud/endpoint model`))
              }
            }
          } catch { /* non-fatal — proxy may be offline */ }
        }
      } else {
        // Interactive model picker — fetch from proxy, show availability tags
        let models: Array<{ id: string; displayName?: string; availability?: string }> = []
        if (opts) {
          try {
            const res = await fetch(`${opts.apiBaseUrl}/v1/models`, { signal: AbortSignal.timeout(5000) })
            if (res.ok) {
              const data = await res.json() as { data?: Array<{ id: string; display_name?: string; availability?: string }> }
              models = (data.data ?? []).map(m => ({
                id: m.id,
                displayName: m.display_name,
                availability: m.availability,
              }))
            }
          } catch { /* ignore — will show empty list */ }
        }

        // Filter chat-capable models for the interactive picker.
        const interactiveModels = models.filter(m => isInteractiveChatModelName(m.id))
        const sourceModels = interactiveModels.length > 0 ? interactiveModels : models

        // Separate available/unknown from unavailable — show available first
        const usable = sourceModels.filter(m => m.availability !== 'unavailable')
        const unavail = sourceModels.filter(m => m.availability === 'unavailable')

        if (usable.length > 0 || unavail.length > 0) {
          const pickerItems: PickerItem<string>[] = [
            ...usable.map(m => ({
              label: `${m.id}`,
              description: [
                m.id === conversation.model ? '← current' : '',
                m.availability === 'available' ? '✓' : '?',
              ].filter(Boolean).join(' '),
              value: m.id,
            })),
            // Show unavailable models dimmed at the end (still selectable)
            ...unavail.map(m => ({
              label: `${m.id}`,
              description: '✗ unavailable',
              value: m.id,
            })),
          ]

          const result = await showPicker({
            title: 'Select Model',
            items: pickerItems,
            placeholder: 'Search models…',
            visibleCount: 12,
            stream: process.stdout,
            readline: rl,
          })

          if (!result.cancelled && result.item) {
            conversation.model = result.item.value
            console.log(`${themeColor('success')}✓ Switched to: ${sgr.bold}${result.item.value}${sgr.reset}`)
          } else {
            console.log(dim('Model selection cancelled.'))
          }
        } else {
          console.log(`${sgr.bold}Current model:${sgr.reset} ${themeColor('owl')}${conversation.model}${sgr.reset}`)
          console.log(`${dim('No models available from proxy. Use /model <name> to set manually.')}`)
        }
      }
      return true

    case '/clear':
      // Wipe both visible screen AND scrollback. Two-layer strategy:
      //
      //   1. Nuclear ANSI (ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME).
      //      Handles the client terminal's own scrollback (Terminal.app,
      //      iTerm2, etc. when NOT running inside tmux).
      //
      //   2. When inside tmux, also shell out to `tmux clear-history`.
      //      tmux maintains its own pane history buffer independent of
      //      the client terminal's scrollback, and by default does NOT
      //      honor CSI 3 J (the E3 terminal-features cap is rarely
      //      configured in default tmux setups). Without this second
      //      step, /clear inside tmux looks like it worked but
      //      `tmux capture-pane -S -300` still reveals the pre-clear
      //      transcript.
      //
      // Direct stdout.write is safe here because /clear runs
      // synchronously outside any frame cycle — no race with
      // writeDiffToTerminal. Default Ink full-resets use the
      // scrollback-preserving sequence, so watermark-v2 committed rows
      // survive resize and other non-/clear paths.
      process.stdout.write(getNuclearClearSequence())
      if (process.env['TMUX']) {
        try {
          execSync('tmux clear-history', { stdio: 'ignore' })
        } catch {
          // Non-fatal — the nuclear ANSI above is the fallback even
          // when shelling out fails (e.g., tmux binary absent but
          // $TMUX set by some mis-inherited env).
        }
      }
      conversation.turns = []
      usage.reset()
      console.log('Conversation cleared.')
      return true

    case '/undo': {
      // Remove last assistant exchange (user + assistant pair, or just assistant if last)
      if (conversation.turns.length === 0) {
        console.log(dim('Nothing to undo — conversation is empty.'))
        return true
      }
      // Find last assistant turn and remove it + any preceding user turn
      let removed = 0
      // Remove trailing tool-result user turns + assistant turns until we hit a real user turn
      while (conversation.turns.length > 0) {
        const last = conversation.turns[conversation.turns.length - 1]!
        if (last.role === 'assistant') {
          conversation.turns.pop()
          removed++
        } else if (last.role === 'user' && removed > 0) {
          // Check if this is a tool-result user turn (array of tool_result blocks)
          const isToolResult = Array.isArray(last.content) &&
            last.content.length > 0 &&
            typeof last.content[0] === 'object' &&
            'type' in last.content[0] &&
            last.content[0].type === 'tool_result'
          if (isToolResult) {
            conversation.turns.pop()
            removed++
          } else {
            // This is the real user message that triggered the exchange — remove it too
            conversation.turns.pop()
            removed++
            break
          }
        } else {
          break
        }
      }
      if (removed > 0) {
        console.log(`${themeColor('success')}✓ Undid last exchange (${removed} turn${removed > 1 ? 's' : ''} removed) — ${conversation.turns.length} turns remaining${sgr.reset}`)
      } else {
        console.log(dim('Nothing to undo.'))
      }
      conversation.turns = sanitizeConversationTurns(conversation.turns)
      return true
    }

    case '/retry': {
      // Find the last real user message text, undo the exchange, then re-inject
      if (conversation.turns.length === 0) {
        console.log(dim('Nothing to retry — conversation is empty.'))
        return true
      }
      // Scan backwards for the last real user turn (not a tool_result turn)
      let lastUserText: string | null = null
      for (let i = conversation.turns.length - 1; i >= 0; i--) {
        const turn = conversation.turns[i]!
        if (turn.role !== 'user') continue
        const isToolResult = turn.content.length > 0 &&
          typeof turn.content[0] === 'object' &&
          'type' in turn.content[0] &&
          turn.content[0].type === 'tool_result'
        if (isToolResult) continue
        // Found a real user turn — extract text
        for (const b of turn.content) {
          if (b.type === 'text' && 'text' in b) {
            lastUserText = b.text
            break
          }
        }
        break
      }
      if (!lastUserText) {
        console.log(dim('No user message found to retry.'))
        return true
      }

      // Undo the last exchange (same logic as /undo)
      let removed = 0
      while (conversation.turns.length > 0) {
        const last = conversation.turns[conversation.turns.length - 1]!
        if (last.role === 'assistant') {
          conversation.turns.pop()
          removed++
        } else if (last.role === 'user' && removed > 0) {
          const isToolRes = Array.isArray(last.content) &&
            last.content.length > 0 &&
            typeof last.content[0] === 'object' &&
            'type' in last.content[0] &&
            last.content[0].type === 'tool_result'
          if (isToolRes) {
            conversation.turns.pop()
            removed++
          } else {
            conversation.turns.pop()
            removed++
            break
          }
        } else {
          break
        }
      }

      console.log(`${themeColor('info')}↻ Retrying last message…${sgr.reset}`)
      // Schedule the retry text to be processed as a new line event
      // after this handler returns and rl.prompt() is called
      if (rl) {
        setImmediate(() => rl.emit('line', lastUserText))
      }
      return true
    }

    case '/compact': {
      const keepN = arg ? parseInt(arg, 10) : 6
      if (isNaN(keepN) || keepN < 0) {
        console.log('Usage: /compact [N]  — keep last N turns (default: 6)')
        return true
      }
      const before = conversation.turns.length
      if (before === 0) {
        console.log(dim('Nothing to compact — conversation is empty.'))
        return true
      }
      if (keepN >= before) {
        console.log(dim(`Already at ${before} turns — nothing to compact.`))
        return true
      }

      // Turns to drop and keep
      const dropped = before - (keepN === 0 ? 0 : keepN)
      const droppedTurns = conversation.turns.slice(0, dropped)
      let droppedTokens = 0
      for (const turn of droppedTurns) {
        for (const block of turn.content) {
          if (block.type === 'text') {
            droppedTokens += estimateTokens(block.text)
          }
        }
      }

      // Try LLM-based summarization when available
      let summaryText: string | null = null
      if (droppedTurns.length >= 2 && opts) {
        writeSlashOutput(output, dim('  Summarizing with LLM…'), { transient: true })
        try {
          // Build a condensed transcript of turns to summarize
          const transcript = droppedTurns.map(t => {
            const texts: string[] = []
            for (const b of t.content) {
              if (b.type === 'text' && 'text' in b) texts.push(b.text.slice(0, 800))
              else if (b.type === 'tool_use') texts.push(`[tool: ${(b as any).name}]`)
              else if (b.type === 'tool_result') texts.push(`[tool_result: ${((b as any).content ?? '').toString().slice(0, 200)}]`)
            }
            return `[${t.role}]: ${texts.join(' ')}`
          }).join('\n')

          const resp = await fetch(`${opts.apiBaseUrl}/v1/messages`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': opts.apiKey || 'owlcoda-internal',
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: conversation.model,
              max_tokens: 2048,
              messages: [{
                role: 'user',
                content: `Summarize this conversation history concisely. Preserve: key decisions, file paths mentioned, current task context, and any important facts. Do NOT include pleasantries or meta-commentary.\n\n${transcript}`,
              }],
              system: 'You are a conversation compressor. Output a concise summary paragraph preserving essential context for continuing the conversation. Be factual and dense.',
            }),
            signal: AbortSignal.timeout(30000),
          })

          if (resp.ok) {
            const result = await resp.json() as { content?: Array<{ text?: string }> }
            summaryText = result.content?.[0]?.text ?? null
          }
          clearSlashTransient(output)
        } catch {
          clearSlashTransient(output)
          // Fall through to simple compaction
        }
      }

      // Build summary message
      const header = `[Conversation compacted: ${dropped} turn${dropped !== 1 ? 's' : ''} (~${Math.round(droppedTokens / 1000)}K tokens) summarized]`
      const fullSummary = summaryText
        ? `${header}\n\n${summaryText}`
        : `${header}`

      // Keep last N turns, prepend summary as a synthetic user turn
      const keptTurns = keepN === 0 ? [] : conversation.turns.slice(-keepN)

      // Insert summary as the first turn (user role, so the model sees context)
      const summaryTurn: import('./protocol/types.js').ConversationTurn = {
        role: 'user',
        content: [{ type: 'text', text: fullSummary }],
        timestamp: Date.now(),
      }
      conversation.turns = [summaryTurn, ...keptTurns]

      const method = summaryText ? 'LLM summary' : 'truncation'
      console.log(`${themeColor('success')}✓${sgr.reset} Compacted: ${before} → ${conversation.turns.length} turns (${method})`)
      console.log(dim(`  Dropped ~${Math.round(droppedTokens / 1000)}K tokens from ${dropped} older turn${dropped !== 1 ? 's' : ''}`))
      return true
    }

    case '/save': {
      const filePath = saveSession(conversation, arg || undefined)
      console.log(`Session saved: ${conversation.id}`)
      console.log(`  File: ${filePath}`)
      return true
    }

    case '/copy': {
      // Copy last assistant response text to clipboard
      let lastText = ''
      for (let i = conversation.turns.length - 1; i >= 0; i--) {
        const turn = conversation.turns[i]!
        if (turn.role !== 'assistant') continue
        for (const block of turn.content) {
          if (block.type === 'text' && 'text' in block) {
            lastText = (block as { type: 'text'; text: string }).text
            break
          }
        }
        if (lastText) break
      }
      if (!lastText) {
        console.log(dim('No assistant response to copy.'))
        return true
      }
      try {
        // macOS: pbcopy, Linux: xclip or xsel, fallback: show message
        const platform = process.platform
        if (platform === 'darwin') {
          execSync('pbcopy', { input: lastText, timeout: 3000 })
          console.log(`${themeColor('success')}✓${sgr.reset} Copied to clipboard (${lastText.length} chars)`)
        } else if (platform === 'linux') {
          try {
            execSync('xclip -selection clipboard', { input: lastText, timeout: 3000 })
          } catch {
            execSync('xsel --clipboard --input', { input: lastText, timeout: 3000 })
          }
          console.log(`${themeColor('success')}✓${sgr.reset} Copied to clipboard (${lastText.length} chars)`)
        } else {
          console.log(dim('Clipboard not supported on this platform. Last response:'))
          console.log(lastText.slice(0, 200) + (lastText.length > 200 ? '…' : ''))
        }
      } catch {
        console.log(dim(`Clipboard command failed. Response (${lastText.length} chars):`))
        console.log(lastText.slice(0, 200) + (lastText.length > 200 ? '…' : ''))
      }
      return true
    }

    case '/sessions': {
      const subParts = arg.split(/\s+/)
      const sub = subParts[0]?.toLowerCase()
      const subArg = subParts.slice(1).join(' ')

      if (sub === 'delete' && subArg) {
        const ok = deleteSession(subArg)
        console.log(ok ? `${ansi.green}✓${ansi.reset} Deleted session ${subArg}` : `${ansi.red}✗${ansi.reset} Session ${subArg} not found`)
        return true
      }

      if (sub === 'info' && subArg) {
        const session = loadSession(subArg)
        if (!session) {
          console.log(`${ansi.red}✗${ansi.reset} Session ${subArg} not found`)
          return true
        }
        console.log(renderSessionInfoPanel(session, process.stdout.columns))
        return true
      }

      const sessions = listSessions()
      console.log(renderSessionsPanel(sessions, { columns: process.stdout.columns, selectedIndex: 0 }))
      return true
    }

    case '/session': {
      const lines = [
        `${ansi.bold}Current session:${ansi.reset}`,
        `  ID:      ${conversation.id}`,
        `  Model:   ${ansi.cyan}${conversation.model}${ansi.reset}`,
        `  Turns:   ${conversation.turns.length}`,
        `  System:  ${ansi.dim}${(conversation.system ?? '').slice(0, 60)}…${ansi.reset}`,
      ]
      console.log(lines.join('\n'))
      return true
    }

    case '/resume': {
      const target = arg || 'last'
      const resolution = resolveLiveReplResumeTarget(target, {
        currentClientId: opts?.liveReplClientId,
        runtime: opts?.liveReplRuntime,
      })
      const sessionToLoad = resolution.session

      if (sessionToLoad) {
        const resumeDispatcher = dispatcher ?? new ToolDispatcher()
        const tools = buildNativeToolDefs(resumeDispatcher)
        const restored = restoreConversation(sessionToLoad, tools)
        // Copy restored state into current conversation
        conversation.turns = restored.turns
        conversation.model = restored.model
        conversation.id = restored.id
        conversation.system = restored.system
        if (opts?.liveReplClientId) {
          updateLiveReplClientSession(opts.liveReplClientId, restored.id)
        }
        if (target === 'last' && resolution.skippedLiveSessionIds.length > 0) {
          console.log(`Skipped ${resolution.skippedLiveSessionIds.length} live-owned session${resolution.skippedLiveSessionIds.length === 1 ? '' : 's'} and resumed ${sessionToLoad.id}`)
        }
        console.log(`${ansi.green}✓${ansi.reset} Resumed session ${sessionToLoad.id}`)
        console.log(`  ${sessionToLoad.turns.length} turns, model: ${sessionToLoad.model}`)
      } else if (resolution.reason === 'owned_by_live_client' && resolution.blockedBy) {
        console.log(
          `${ansi.red}✗${ansi.reset} Session "${target}" is currently owned by live REPL client PID ${resolution.blockedBy.clientPid}. Resume it from that client or choose another session.`,
        )
      } else if (target === 'last' && resolution.reason === 'no_resumable_session') {
        console.log(`${ansi.dim}No resumable session available — recent sessions are owned by other active live REPL clients.${ansi.reset}`)
      } else {
        console.log(`${ansi.red}✗${ansi.reset} Session "${target}" not found.`)
      }
      return true
    }

    case '/history': {
      const limit = arg ? parseInt(arg, 10) : 20
      const n = isNaN(limit) || limit < 1 ? 20 : limit
      const turns = conversation.turns.slice(-n)

      if (turns.length === 0) {
        console.log(`${ansi.dim}No messages yet.${ansi.reset}`)
        return true
      }

      const lines = [`${ansi.bold}History (last ${turns.length} of ${conversation.turns.length}):${ansi.reset}`, '']
      for (const t of turns) {
        const icon = t.role === 'user' ? '👤' : '🤖'
        // Extract text from content blocks
        let text = ''
        if (Array.isArray(t.content)) {
          for (const block of t.content) {
            if ('text' in block && typeof block.text === 'string') {
              text += block.text + ' '
            } else if ('type' in block && block.type === 'tool_use') {
              text += `[tool: ${(block as any).name}] `
            } else if ('type' in block && block.type === 'tool_result') {
              text += '[tool result] '
            }
          }
        }
        const preview = text.trim().slice(0, 100).replace(/\n/g, ' ')
        const time = t.timestamp ? `${ansi.dim}${new Date(t.timestamp).toLocaleTimeString()}${ansi.reset}` : ''
        lines.push(`  ${icon} ${preview || ansi.dim + '(empty)' + ansi.reset} ${time}`)
      }
      console.log(lines.join('\n'))
      return true
    }

    case '/search': {
      if (!arg) {
        console.log(`${ansi.yellow}Usage: /search <query>${ansi.reset}`)
        console.log(dim('  Search within current conversation for matching text.'))
        return true
      }
      const query = arg.toLowerCase()
      const hits: Array<{ turnIdx: number; role: string; preview: string; time?: string }> = []
      for (let i = 0; i < conversation.turns.length; i++) {
        const turn = conversation.turns[i]!
        for (const block of turn.content) {
          let text = ''
          if ('text' in block && typeof block.text === 'string') {
            text = block.text
          } else if ('content' in block && typeof block.content === 'string') {
            text = block.content
          }
          if (text.toLowerCase().includes(query)) {
            // Find the matching line for context
            const lines = text.split('\n')
            const matchLine = lines.find(l => l.toLowerCase().includes(query)) ?? text.slice(0, 120)
            const preview = matchLine.trim().slice(0, 120).replace(/\n/g, ' ')
            const time = turn.timestamp ? new Date(turn.timestamp).toLocaleTimeString() : undefined
            hits.push({ turnIdx: i, role: turn.role, preview, time })
            break // one hit per turn
          }
        }
      }

      if (hits.length === 0) {
        console.log(dim(`No matches for "${arg}" in ${conversation.turns.length} turns.`))
      } else {
        console.log(`\n  ${sgr.bold}Search: "${arg}" — ${hits.length} match${hits.length !== 1 ? 'es' : ''}${sgr.reset}\n`)
        for (const hit of hits.slice(0, 20)) {
          const icon = hit.role === 'user' ? '👤' : '🤖'
          const time = hit.time ? dim(` ${hit.time}`) : ''
          // Highlight matching portion
          const idx = hit.preview.toLowerCase().indexOf(query)
          let display: string
          if (idx >= 0) {
            display = hit.preview.slice(0, idx) +
              `${sgr.bold}${themeColor('owl')}${hit.preview.slice(idx, idx + query.length)}${sgr.reset}` +
              hit.preview.slice(idx + query.length)
          } else {
            display = hit.preview
          }
          console.log(`  [${hit.turnIdx}] ${icon} ${display}${time}`)
        }
        if (hits.length > 20) {
          console.log(dim(`  … and ${hits.length - 20} more matches`))
        }
        console.log()
      }
      return true
    }

    case '/export': {
      const format = arg.toLowerCase() === 'markdown' ? 'markdown' : 'json'
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const ext = format === 'markdown' ? 'md' : 'json'
      const filename = `owlcoda-export-${ts}.${ext}`
      const filepath = join(process.cwd(), filename)

      if (format === 'json') {
        const data = {
          id: conversation.id,
          model: conversation.model,
          turns: conversation.turns.length,
          exportedAt: new Date().toISOString(),
          messages: conversation.turns.map(t => ({
            role: t.role,
            content: t.content,
            timestamp: t.timestamp,
          })),
        }
        writeFileSync(filepath, JSON.stringify(data, null, 2))
      } else {
        // Markdown format
        const lines = [
          `# OwlCoda Conversation Export`,
          ``,
          `- **Model**: ${conversation.model}`,
          `- **Session**: ${conversation.id}`,
          `- **Exported**: ${new Date().toISOString()}`,
          `- **Turns**: ${conversation.turns.length}`,
          ``,
          `---`,
          ``,
        ]
        for (const t of conversation.turns) {
          const role = t.role === 'user' ? '## 👤 User' : '## 🤖 Assistant'
          lines.push(role)
          lines.push('')
          if (Array.isArray(t.content)) {
            for (const block of t.content) {
              if ('text' in block && typeof block.text === 'string') {
                lines.push(block.text)
              } else if ('type' in block && block.type === 'tool_use') {
                lines.push(`> Tool: \`${(block as any).name}\``)
              }
            }
          }
          lines.push('')
        }
        writeFileSync(filepath, lines.join('\n'))
      }

      console.log(`${ansi.green}✓${ansi.reset} Exported to: ${filepath}`)
      return true
    }

    case '/budget': {
      const est = estimateConversationTokens(conversation)
      const contextWindow = resolveModelContextWindow(loadConfig(), conversation.model)
      console.log(formatBudget(est.totalTokens, contextWindow))
      return true
    }

    case '/turns': {
      const userTurns = conversation.turns.filter(t => t.role === 'user').length
      const assistantTurns = conversation.turns.filter(t => t.role === 'assistant').length
      console.log(`  Turns: ${conversation.turns.length} (👤 ${userTurns} · 🤖 ${assistantTurns})`)
      return true
    }

    case '/cost':
    case '/tokens':
      console.log(usage.formatUsage())
      return true

    // ─── Round 32: core slash commands ──────────────────────

    case '/status': {
      const lines = [
        `${ansi.bold}Session status:${ansi.reset}`,
        `  Model:     ${ansi.cyan}${conversation.model}${ansi.reset}`,
        `  Session:   ${conversation.id}`,
        `  Turns:     ${conversation.turns.length}`,
        `  Max tokens: ${conversation.maxTokens}`,
      ]
      if (opts) {
        lines.push(`  Proxy:     ${opts.apiBaseUrl}`)
      }
      lines.push(`  Trace:     ${isTraceEnabled() ? 'ON' : 'OFF'}`)
      lines.push(`  Config:    ${getOwlcodaDirLabel()}`)
      if (approveState) {
        lines.push(`  Approve:   ${approveState.autoApprove ? 'auto' : 'manual'}`)
      }
      console.log(lines.join('\n'))
      return true
    }

    case '/config': {
      const lines = [
        `${ansi.bold}OwlCoda v${VERSION} — Runtime Config${ansi.reset}`,
        '',
        `  Active model:    ${ansi.cyan}${conversation.model}${ansi.reset}`,
        `  Max tokens:      ${conversation.maxTokens}`,
        `  Mode:            native`,
      ]
      if (opts) {
        lines.push(`  Proxy:           ${opts.apiBaseUrl}`)
      }
      lines.push(
        `  Trace:           ${isTraceEnabled() ? 'ON' : 'OFF'}`,
        `  OWLCODA_HOME:    ${getOwlcodaDirLabel()}`,
        '',
        `${ansi.bold}  Session:${ansi.reset}`,
        `    ID:       ${conversation.id}`,
        `    Turns:    ${conversation.turns.length}`,
      )
      console.log(lines.join('\n'))
      return true
    }

    case '/settings': {
      const globalPermsDisplay = [...loadPermissions()].sort()
      console.log(renderSettingsPanel({
        version: VERSION,
        model: conversation.model,
        maxTokens: conversation.maxTokens,
        mode: 'native',
        trace: isTraceEnabled(),
        owlcodaHome: getOwlcodaDirLabel(),
        apiBaseUrl: opts?.apiBaseUrl,
        approveMode: approveState?.autoApprove ? 'auto-approve' : 'ask-before-execute',
        theme: getThemeName(),
        alwaysApprovedTools: globalPermsDisplay,
        columns: process.stdout.columns,
      }))
      return true
    }

    case '/capabilities': {
      const lines = [`${ansi.bold}Capabilities:${ansi.reset}`, '']
      const statusIcons: Record<string, string> = {
        supported: `${ansi.green}✓${ansi.reset}`,
        partial: `${ansi.yellow}◐${ansi.reset}`,
        best_effort: `${ansi.yellow}~${ansi.reset}`,
        'manual-only': `${ansi.magenta}✋${ansi.reset}`,
        blocked: `${ansi.red}✗${ansi.reset}`,
        unsupported: `${ansi.red}✗${ansi.reset}`,
      }
      for (const cap of CAPABILITIES) {
        const icon = statusIcons[cap.status] ?? '?'
        lines.push(`  ${icon} ${cap.name} ${ansi.dim}(${cap.status})${ansi.reset}`)
        if (cap.detail) {
          lines.push(`    ${ansi.dim}${cap.detail}${ansi.reset}`)
        }
      }
      console.log(lines.join('\n'))
      return true
    }

    case '/doctor': {
      const ok = `${ansi.green}✓${ansi.reset}`
      const warn = `${ansi.yellow}⚠${ansi.reset}`
      const fail = `${ansi.red}✗${ansi.reset}`
      const interaction = getTranscriptInteractionCapability()
      const lines = [`${ansi.bold}OwlCoda Doctor v${VERSION}${ansi.reset}`, '']

      // ── Environment ──
      lines.push(`  ${ansi.bold}Environment${ansi.reset}`)
      const nodeVer = process.version
      lines.push(`  ${ok} Node.js: ${nodeVer}`)
      try {
        const gitVer = execSync('git --version', { encoding: 'utf8', timeout: 3000 }).trim().replace('git version ', '')
        lines.push(`  ${ok} Git: ${gitVer}`)
      } catch {
        lines.push(`  ${fail} Git: not found`)
      }
      lines.push(`  ${ansi.dim}   CWD: ${process.cwd()}${ansi.reset}`)
      lines.push(`  ${ansi.dim}   PID: ${process.pid}${ansi.reset}`)
      lines.push('')

      // ── Transcript interaction ──
      lines.push(`  ${ansi.bold}Transcript Interaction${ansi.reset}`)
      lines.push(`  ${ok} Mode: ${interaction.selectionSummary}`)
      lines.push(`  ${interaction.wheelSupport === 'verified' ? ok : warn} Wheel: ${interaction.wheelSummary}`)
      lines.push(`  ${ansi.dim}   Detected environment: ${interaction.environmentLabel}${ansi.reset}`)
      lines.push('')

      // ── Proxy + Models ──
      lines.push(`  ${ansi.bold}Backend${ansi.reset}`)
      if (opts) {
        try {
          const truth = await fetchAdminModelTruth(opts, { skipCache: true })
          if (truth.runtimeOk) {
            const source = truth.runtimeSource ?? 'runtime'
            lines.push(`  ${ok} Local runtime: Healthy via ${source} → ${opts.apiBaseUrl}`)
            lines.push(`  ${ansi.dim}   visible_models=${truth.runtimeModelCount} ${truth.runtimeProbeDetail || ''}`.trimEnd() + `${ansi.reset}`)
          } else {
            lines.push(`  ${fail} Local runtime: Unreachable at ${opts.apiBaseUrl}`)
          }
          const active = truth.statuses.find(status => status.id === conversation.model)
          lines.push(`  ${ansi.dim}🤖${ansi.reset} Active model: ${ansi.cyan}${conversation.model}${ansi.reset}`)
          if (!active) {
            lines.push(`  ${warn} Model not present in truth snapshot`)
          } else if (active.availability.kind === 'ok') {
            lines.push(`  ${ok} Model available`)
          } else {
            lines.push(`  ${warn} Model issue: ${active.availability.kind}`)
          }
          const issues = truth.statuses.filter(status => status.presentIn.config && status.availability.kind !== 'ok')
          if (issues.length > 0) {
            const sample = issues.slice(0, 3).map(status => `${status.id}:${status.availability.kind}`).join(', ')
            lines.push(`  ${ansi.dim}   issues=${issues.length} ${sample}${issues.length > 3 ? ` +${issues.length - 3} more` : ''}${ansi.reset}`)
          }
        } catch {
          lines.push(`  ${fail} Proxy: Unreachable at ${opts.apiBaseUrl}`)
          lines.push(`  ${ansi.dim}🤖${ansi.reset} Active model: ${ansi.cyan}${conversation.model}${ansi.reset}`)
        }
      } else {
        lines.push(`  ${warn} No proxy configured`)
        lines.push(`  ${ansi.dim}🤖${ansi.reset} Active model: ${ansi.cyan}${conversation.model}${ansi.reset}`)
      }
      lines.push('')

      // ── Session ──
      lines.push(`  ${ansi.bold}Session${ansi.reset}`)
      const { totalTokens, systemTokens, turnTokens } = estimateConversationTokens(conversation)
      lines.push(`  ${ansi.dim}💬${ansi.reset} Turns: ${conversation.turns.length}  Tokens: ~${(totalTokens / 1000).toFixed(1)}K (sys: ${(systemTokens / 1000).toFixed(1)}K + turns: ${(turnTokens / 1000).toFixed(1)}K)`)
      const upMs = getUptime()
      const upSec = Math.floor(upMs / 1000)
      const upMin = Math.floor(upSec / 60)
      lines.push(`  ${ansi.dim}⏱${ansi.reset}  Uptime: ${upMin > 0 ? `${upMin}m ${upSec % 60}s` : `${upSec}s`}`)
      lines.push(`  ${ansi.dim}🔍${ansi.reset} Trace: ${isTraceEnabled() ? 'ON' : 'OFF'}`)
      lines.push('')

      // ── Config files ──
      lines.push(`  ${ansi.bold}Configuration${ansi.reset}`)
      const cwd = process.cwd()
      const configFiles = [
        { name: 'OWLCODA.md', path: join(cwd, 'OWLCODA.md') },
        { name: '.mcp.json', path: join(cwd, '.mcp.json') },
        { name: '~/.owlcoda/mcp.json', path: join(homedir(), '.owlcoda', 'mcp.json') },
      ]
      for (const cf of configFiles) {
        if (existsSync(cf.path)) {
          const sz = statSync(cf.path).size
          lines.push(`  ${ok} ${cf.name} (${(sz / 1024).toFixed(1)}KB)`)
        } else {
          lines.push(`  ${ansi.dim}  ${cf.name}: not found${ansi.reset}`)
        }
      }
      lines.push('')

      // ── Errors ──
      const recentErrors = getRecentErrors(3)
      if (recentErrors.length > 0) {
        lines.push(`  ${ansi.bold}Recent errors${ansi.reset}`)
        for (const e of recentErrors) {
          const time = e.timestamp.slice(11, 19)
          lines.push(`  ${fail} [${time}] ${e.endpoint}: ${e.message.slice(0, 80)}`)
          if (e.suggestion) lines.push(`     ${ansi.dim}💡 ${e.suggestion}${ansi.reset}`)
        }
        lines.push('')
      } else if (getErrorCount() === 0) {
        lines.push(`  ${ok} No errors recorded`)
        lines.push('')
      }

      console.log(lines.join('\n'))
      return true
    }

    case '/trace': {
      if (arg === 'on' || arg === 'yes' || arg === '1') {
        setTraceEnabled(true)
      } else if (arg === 'off' || arg === 'no' || arg === '0') {
        setTraceEnabled(false)
      } else {
        setTraceEnabled(!isTraceEnabled())
      }
      const state = isTraceEnabled() ? 'ON' : 'OFF'
      const detail = isTraceEnabled() ? ' (trace files → ~/.owlcoda/trace/)' : ''
      console.log(`${ansi.dim}Trace: ${state}${detail}${ansi.reset}`)
      return true
    }

    // ─── Round 34: observability commands ──────────────────

    case '/dashboard': {
      // Fetch real metrics from the running proxy process
      const proxyUrl = opts?.apiBaseUrl ?? 'http://127.0.0.1:8019'
      let m: any
      try {
        const resp = await fetch(`${proxyUrl}/dashboard`)
        m = await resp.json()
      } catch {
        // Fallback to local counters if proxy unreachable
        m = getMetrics()
      }
      const lines = [
        `${ansi.bold}OwlCoda Dashboard:${ansi.reset}`,
        `  Version:         ${m.version}`,
        `  Uptime:          ${m.uptime}s`,
        `  Total requests:  ${m.totalRequests}`,
        `  Active requests: ${m.activeRequests}`,
        '',
      ]
      const modelKeys = Object.keys(m.requestsByModel ?? {})
      if (modelKeys.length > 0) {
        lines.push(`${ansi.bold}  Requests by endpoint:${ansi.reset}`)
        for (const [k, v] of Object.entries(m.requestsByModel as Record<string, number>)) {
          const avg = (m.avgDurationByModel as Record<string, number>)?.[k] ?? '-'
          lines.push(`    ${k}: ${v} reqs (avg ${avg}ms)`)
        }
        lines.push('')
      }
      // Token display: prefer conversation-level (accurate) over proxy-level
      const convTokens = (conversation as any)?.usageTracker
      const tokenUsage = m.tokenUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      lines.push(`${ansi.bold}  Tokens:${ansi.reset}`)
      lines.push(`    Input:  ${tokenUsage.inputTokens.toLocaleString()}`)
      lines.push(`    Output: ${tokenUsage.outputTokens.toLocaleString()}`)
      lines.push(`    Total:  ${tokenUsage.totalTokens.toLocaleString()}`)
      lines.push('')
      lines.push(`  Recent errors: ${m.recentErrors ?? 0}`)

      const budgets = m.errorBudgets ?? {}
      const budgetKeys = Object.keys(budgets)
      if (budgetKeys.length > 0) {
        lines.push('')
        lines.push(`${ansi.bold}  Error Budgets:${ansi.reset}`)
        const slo = m.sloTarget ?? 0.95
        for (const [model, b] of Object.entries(budgets as Record<string, any>)) {
          const icon = b.budgetRemaining >= 0 ? '✓' : '✗'
          lines.push(`    ${icon} ${model}: ${(b.successRate * 100).toFixed(1)}% (${b.total} reqs, SLO ${(slo * 100).toFixed(0)}%)`)
        }
      }

      const traces = m.recentTraces ?? []
      if (traces.length > 0) {
        lines.push('')
        lines.push(`${ansi.bold}  Recent Traces (last ${Math.min(3, traces.length)}):${ansi.reset}`)
        for (const t of traces.slice(-3)) {
          lines.push(`    ${t.requestId.slice(0, 8)} — ${t.totalMs}ms`)
        }
      }

      console.log(lines.join('\n'))
      return true
    }

    case '/audit': {
      const count = arg ? parseInt(arg, 10) : 10
      const n = isNaN(count) || count < 1 ? 10 : count
      const entries = await readAuditLog(n)
      if (entries.length === 0) {
        console.log(`${ansi.dim}No audit entries yet.${ansi.reset}`)
        return true
      }
      const lines = [`${ansi.bold}Audit Log (last ${entries.length}):${ansi.reset}`, '']
      for (const e of entries) {
        const fb = e.fallbackUsed ? ' [fallback]' : ''
        const stream = e.streaming ? ' [stream]' : ''
        lines.push(`  ${e.timestamp.slice(11, 19)} ${e.model}→${e.servedBy ?? e.model} ${e.status} ${e.inputTokens}/${e.outputTokens}tok${fb}${stream}`)
      }
      console.log(lines.join('\n'))
      return true
    }

    case '/health': {
      // Fetch real health data from proxy
      const proxyUrl = opts?.apiBaseUrl ?? 'http://127.0.0.1:8019'
      let proxyData: any = null
      try {
        const resp = await fetch(`${proxyUrl}/dashboard`)
        proxyData = await resp.json()
      } catch { /* fall through to local */ }

      const circuits = proxyData?.errorBudgets
        ? Object.fromEntries(Object.entries(proxyData.errorBudgets as Record<string, any>).map(([model, b]: [string, any]) => [
            model,
            { state: b.failures > 4 ? 'open' : 'closed', failures: b.failures ?? 0 },
          ]))
        : getAllCircuitStates()
      const circuitModels = Object.keys(circuits)
      if (circuitModels.length === 0) {
        console.log(`${ansi.dim}No circuit breaker data — no requests made yet.${ansi.reset}`)
        return true
      }
      const lines = [`${ansi.bold}Model Health:${ansi.reset}`, '']
      for (const [model, c] of Object.entries(circuits)) {
        const state = (c as any).state ?? 'closed'
        const failures = (c as any).failures ?? 0
        const icon = state === 'closed' ? `${ansi.green}✓${ansi.reset}` : state === 'open' ? `${ansi.red}✗${ansi.reset}` : `${ansi.yellow}◐${ansi.reset}`
        lines.push(`  ${icon} ${model}  circuit:${state} (${failures} failures)`)
      }
      console.log(lines.join('\n'))
      return true
    }

    case '/ratelimit': {
      // Fetch from proxy
      const proxyUrl = opts?.apiBaseUrl ?? 'http://127.0.0.1:8019'
      let rateLimits: Record<string, any> | null = null
      try {
        const resp = await fetch(`${proxyUrl}/dashboard`)
        const data = await resp.json() as any
        if (data?.rateLimits) rateLimits = data.rateLimits as Record<string, any>
      } catch { /* fall through to local */ }

      const stats = rateLimits ?? getRateLimitStats()
      const models = Object.keys(stats)
      if (models.length === 0) {
        console.log(`${ansi.dim}No rate limit data — no requests made yet.${ansi.reset}`)
        return true
      }
      const lines = [`${ansi.bold}Rate Limits:${ansi.reset}`]
      for (const [model, s] of Object.entries(stats)) {
        const remaining = (s as any).remaining ?? 0
        const total = (s as any).total ?? 0
        const resetMs = (s as any).resetAtMs ?? (s as any).resetAt ?? 0
        lines.push(`  ${model}: ${remaining}/${total} remaining (resets ${new Date(resetMs).toLocaleTimeString()})`)
      }
      console.log(lines.join('\n'))
      return true
    }

    case '/slo': {
      // Fetch from proxy
      const proxyUrl = opts?.apiBaseUrl ?? 'http://127.0.0.1:8019'
      let proxyData: any = null
      try {
        const resp = await fetch(`${proxyUrl}/dashboard`)
        proxyData = await resp.json()
      } catch { /* fall through to local */ }

      const budgetEntries = proxyData?.errorBudgets
        ? Object.entries(proxyData.errorBudgets as Record<string, any>)
        : [...getAllBudgets().entries()].map(([k, v]) => [k, v] as [string, any])
      const slo = proxyData?.sloTarget ?? getSloTarget()

      if (budgetEntries.length === 0) {
        console.log(`${ansi.dim}No request data yet. Error budgets populate after first request.${ansi.reset}`)
        return true
      }
      const lines = [`${ansi.bold}Error Budget:${ansi.reset}`, `  SLO target: ${(slo * 100).toFixed(0)}%`, '']
      lines.push(`  ${'Model'.padEnd(35)} ${'Reqs'.padStart(5)} ${'OK%'.padStart(6)} ${'Budget'.padStart(8)} Status`)
      lines.push(`  ${'─'.repeat(65)}`)
      for (const [model, b] of budgetEntries) {
        const rate = ((b as any).successRate * 100).toFixed(1)
        const budget = ((b as any).budgetRemaining * 100).toFixed(1)
        const status = (b as any).budgetRemaining >= 0 ? '✓ OK' : '✗ VIOLATED'
        lines.push(`  ${model.padEnd(35)} ${String((b as any).total).padStart(5)} ${rate.padStart(5)}% ${(budget + '%').padStart(8)} ${status}`)
      }
      console.log(lines.join('\n'))
      return true
    }

    case '/traces': {
      const count = arg ? parseInt(arg, 10) : 5
      const n = isNaN(count) || count < 1 ? 5 : count

      // Fetch from proxy
      const proxyUrl = opts?.apiBaseUrl ?? 'http://127.0.0.1:8019'
      let traces: any[] = []
      try {
        const resp = await fetch(`${proxyUrl}/dashboard`)
        const data = await resp.json() as any
        if (data?.recentTraces?.length) {
          traces = (data.recentTraces as any[]).slice(0, n)
        }
      } catch { /* fall through to local */ }
      if (traces.length === 0) {
        traces = getRecentTraces(n)
      }

      if (traces.length === 0) {
        console.log(`${ansi.dim}No request traces yet.${ansi.reset}`)
        return true
      }
      const lines = [`${ansi.bold}Recent Traces:${ansi.reset}`, '']
      for (const t of traces) {
        const id = (t.requestId ?? t.id ?? '').slice(0, 8)
        const ms = t.totalMs ?? t.duration ?? 0
        lines.push(`  ${id} — ${ms}ms total`)
        const phases = t.phases ?? []
        for (const p of phases) {
          lines.push(`    ${(p.name ?? '').padEnd(15)} +${p.durationMs ?? p.duration ?? 0}ms`)
        }
        lines.push('')
      }
      console.log(lines.join('\n'))
      return true
    }

    case '/perf': {
      // Try proxy dashboard for latency stats
      const proxyUrl = opts?.apiBaseUrl ?? 'http://127.0.0.1:8019'
      let proxyPerf = ''
      try {
        const resp = await fetch(`${proxyUrl}/dashboard`)
        const data = await resp.json() as any
        if (data?.recentTraces?.length) {
          const traces = data.recentTraces as any[]
          const lines = [`${ansi.bold}Performance (last ${traces.length} requests):${ansi.reset}`, '']
          const latencies = traces.map((t: any) => t.totalMs ?? t.duration ?? 0).filter((n: number) => n > 0)
          if (latencies.length) {
            const avg = Math.round(latencies.reduce((a: number, b: number) => a + b, 0) / latencies.length)
            const p50 = latencies.sort((a: number, b: number) => a - b)[Math.floor(latencies.length * 0.5)]
            const p99 = latencies.sort((a: number, b: number) => a - b)[Math.floor(latencies.length * 0.99)]
            lines.push(`  avg: ${avg}ms  p50: ${p50}ms  p99: ${p99}ms  (${latencies.length} samples)`)
          }
          proxyPerf = lines.join('\n')
        }
      } catch { /* fall through */ }
      const output = proxyPerf || formatAllPerfSummaries()
      console.log(output || `${ansi.dim}No performance data yet.${ansi.reset}`)
      return true
    }

    case '/metrics': {
      // Fetch from proxy Prometheus endpoint
      const proxyUrl = opts?.apiBaseUrl ?? 'http://127.0.0.1:8019'
      let metricsText = ''
      try {
        const resp = await fetch(`${proxyUrl}/metrics`)
        metricsText = await resp.text()
      } catch { /* fall through to local */ }
      console.log(metricsText || renderMetrics())
      return true
    }

    case '/reset-circuits': {
      resetCircuitBreaker()
      console.log(`${ansi.green}✓ All circuit breakers reset to closed state.${ansi.reset}`)
      return true
    }

    case '/reset-budgets': {
      resetBudgets()
      console.log(`${ansi.green}✓ All error budget windows reset.${ansi.reset}`)
      return true
    }

    // ─── Round 35: backend + model management commands ──────

    case '/backends': {
      const lines: string[] = [`${ansi.bold}Backend Discovery:${ansi.reset}`, '']
      if (opts) {
        try {
          const truth = await fetchAdminModelTruth(opts, { skipCache: true })
          const locals = truth.statuses.filter(status => status.providerKind === 'local' || status.raw.discovered)
          if (locals.length === 0) {
            lines.push('  No local backends detected.')
            lines.push(`${ansi.dim}  Start Ollama (11434), LM Studio (1234), or vLLM (8000) for direct backends.${ansi.reset}`)
          } else {
            const byBackend = new Map<string, typeof locals>()
            for (const status of locals) {
              const backend = status.raw.discovered?.backend ?? 'configured-local'
              if (!byBackend.has(backend)) byBackend.set(backend, [])
              byBackend.get(backend)!.push(status)
            }
            for (const [backend, statuses] of byBackend) {
              const first = statuses[0]!
              const baseUrl = first.raw.discovered?.baseUrl ?? opts.apiBaseUrl
              lines.push(`  ${ansi.bold}${backend}${ansi.reset} — ${baseUrl} (${statuses.length} model${statuses.length > 1 ? 's' : ''})`)
              for (const status of statuses) {
                const parts = [`    ${status.label}`]
                if (status.raw.discovered?.parameterSize) parts.push(`${ansi.dim}${status.raw.discovered.parameterSize}${ansi.reset}`)
                if (status.raw.discovered?.quantization) parts.push(`${ansi.dim}${status.raw.discovered.quantization}${ansi.reset}`)
                if (status.raw.discovered?.contextWindow) parts.push(`${ansi.dim}${Math.round(status.raw.discovered.contextWindow / 1024)}K ctx${ansi.reset}`)
                parts.push(status.availability.kind === 'ok'
                  ? `${ansi.green}ok${ansi.reset}`
                  : `${ansi.yellow}${status.availability.kind}${ansi.reset}`)
                lines.push(parts.join(' '))
              }
              lines.push('')
            }
          }
          console.log(lines.join('\n'))
          return true
        } catch {
          // fall through to direct discovery fallback
        }
      }
      const result = await discoverBackends(undefined, 5000)
      if (result.models.length === 0) {
        lines.push('  No local backends detected.')
        lines.push(`${ansi.dim}  Start Ollama (11434), LM Studio (1234), or vLLM (8000) for direct backends.${ansi.reset}`)
        lines.push('')
        lines.push(`${ansi.dim}  Probed in ${result.durationMs}ms${ansi.reset}`)
      } else {
        const byBackend = new Map<string, typeof result.models>()
        for (const m of result.models) {
          if (!byBackend.has(m.backend)) byBackend.set(m.backend, [])
          byBackend.get(m.backend)!.push(m)
        }
        for (const [backend, models] of byBackend) {
          const first = models[0]!
          lines.push(`  ${ansi.bold}${backend}${ansi.reset} — ${first.baseUrl} (${models.length} model${models.length > 1 ? 's' : ''})`)
          for (const m of models) {
            const parts = [`    ${m.label}`]
            if (m.parameterSize) parts.push(`${ansi.dim}${m.parameterSize}${ansi.reset}`)
            if (m.quantization) parts.push(`${ansi.dim}${m.quantization}${ansi.reset}`)
            if (m.contextWindow) parts.push(`${ansi.dim}${Math.round(m.contextWindow / 1024)}K ctx${ansi.reset}`)
            lines.push(parts.join(' '))
          }
          lines.push('')
        }
        if (result.unreachableBackends.length > 0) {
          lines.push(`${ansi.dim}  Unreachable: ${result.unreachableBackends.join(', ')}${ansi.reset}`)
        }
        lines.push(`${ansi.dim}  ${result.models.length} model${result.models.length > 1 ? 's' : ''} discovered in ${result.durationMs}ms${ansi.reset}`)
      }
      console.log(lines.join('\n'))
      return true
    }

    case '/recommend': {
      const validIntents: Intent[] = ['code', 'analysis', 'search', 'chat', 'general']
      const intent = (arg || 'general') as Intent
      if (!validIntents.includes(intent)) {
        console.log(`${ansi.red}Invalid intent "${intent}". Use: ${validIntents.join(', ')}${ansi.reset}`)
        return true
      }
      try {
        const config = loadConfig()
        const rec = recommendModel(config, intent)
        console.log(formatRecommendation(rec))
      } catch (e: any) {
        console.log(`${ansi.dim}No config file found — cannot recommend. ${e.message}${ansi.reset}`)
      }
      return true
    }

    case '/warmup': {
      try {
        const config = loadConfig()
        const modelsWithEndpoint = config.models.filter((m: any) => m.endpoint)
        if (modelsWithEndpoint.length === 0) {
          console.log(`${ansi.dim}No models with direct endpoints to warm up.${ansi.reset}`)
          return true
        }
        console.log(`${ansi.dim}Warming up ${modelsWithEndpoint.length} model(s)…${ansi.reset}`)
        const results = await warmupModels(config, { concurrency: 2, timeoutMs: 15_000 })
        console.log(formatWarmupResults(results))
      } catch (e: any) {
        console.log(`${ansi.dim}No config file found — cannot warm up. ${e.message}${ansi.reset}`)
      }
      return true
    }

    case '/models': {
      const { runModelsWorkbench } = await import('./models-workbench.js')
      const modelArgs = arg.split(/\s+/).filter(Boolean)
      const first = modelArgs[0]?.toLowerCase()
      const second = modelArgs[1]

      if (first === 'edit' && second) {
        await openAdminHandoffFromSlash({ route: 'models', select: second }, opts)
        return true
      }

      if (first === 'browser' || first === 'open') {
        const route = second === 'aliases' || second === 'orphans' || second === 'catalog' || second === 'models'
          ? second
          : 'models'
        const select = modelArgs[2]
        await openAdminHandoffFromSlash({ route, select, view: route === 'models' && second === 'issues' ? 'issues' : undefined }, opts)
        return true
      }

      if (first === 'aliases' || first === 'orphans' || first === 'catalog') {
        await openAdminHandoffFromSlash({ route: first }, opts)
        return true
      }

      const mode = arg === 'issues' ? 'issues' : arg === 'overview' ? 'overview' : 'default'
      const refresh = arg === 'refresh'
      try {
        await runModelsWorkbench({
          mode,
          refresh,
          rl,
          stream: process.stdout,
          onBrowserHandoff: request => openAdminHandoffFromSlash(request.context, opts, {
            explicitOpen: request.explicitOpen,
            suppressSuccessOutput: request.explicitOpen,
          }),
        })
      } catch (e: any) {
        console.log(`${ansi.dim}Model workstation failed: ${e?.message ?? e}${ansi.reset}`)
      }
      return true
    }

    case '/plugins': {
      if (arg === 'reload') {
        const plugins = await loadPlugins()
        console.log(`Reloaded: ${plugins.length} plugin(s) found`)
        return true
      }
      const plugins = getLoadedPlugins()
      if (plugins.length === 0) {
        console.log(`${ansi.dim}No plugins loaded. Place plugins in ~/.owlcoda/plugins/<name>/index.js${ansi.reset}`)
        return true
      }
      const lines = [`${ansi.bold}Loaded Plugins:${ansi.reset}`, '']
      for (const p of plugins) {
        const meta = p.plugin.metadata
        lines.push(`  📦 ${meta.name} v${meta.version} (${p.hookCount} hooks)`)
        if (meta.description) lines.push(`     ${ansi.dim}${meta.description}${ansi.reset}`)
      }
      console.log(lines.join('\n'))
      return true
    }

    // ─── Round 36: tool approval command ──────────────────

    case '/approve': {
      if (!approveState) {
        console.log(`${ansi.dim}Auto-approve state not available in this context.${ansi.reset}`)
        return true
      }
      const a = arg.toLowerCase()
      if (a === 'on' || a === 'yes' || a === 'true') {
        approveState.autoApprove = true
        console.log(`Auto-approve: ${ansi.green}ON${ansi.reset} — tool calls execute without confirmation.`)
      } else if (a === 'off' || a === 'no' || a === 'false') {
        approveState.autoApprove = false
        console.log(`Auto-approve: ${ansi.yellow}OFF${ansi.reset} — tool calls will require confirmation.`)
      } else {
        // Toggle
        approveState.autoApprove = !approveState.autoApprove
        const state = approveState.autoApprove ? `${ansi.green}ON${ansi.reset}` : `${ansi.yellow}OFF${ansi.reset}`
        console.log(`Auto-approve: ${state}`)
      }
      return true
    }

    case '/verbose': {
      if (!toolCollector) {
        console.log(dim('Verbose mode not available in this context.'))
        return true
      }
      const a = arg.toLowerCase()
      if (a === 'on' || a === 'yes' || a === 'true') {
        toolCollector.verbose = true
      } else if (a === 'off' || a === 'no' || a === 'false') {
        toolCollector.verbose = false
      } else {
        toolCollector.verbose = !toolCollector.verbose
      }
      const state = toolCollector.verbose
        ? `${themeColor('success')}ON${sgr.reset} — tool results shown individually`
        : `${themeColor('warning')}OFF${sgr.reset} — tool results collapsed when grouped`
      console.log(`Verbose: ${state}`)
      return true
    }

    // ─── Round 37: branch, tag, compress ──────────────────

    case '/branch': {
      const name = arg || undefined
      try {
        // Auto-save current conversation before branching
        autoSaveSession(conversation)
        const newId = branchSession(conversation.id, name)
        console.log(`Branched → ${newId}${name ? ` (${name})` : ''}`)
        console.log(`Use /resume ${newId} to switch to it.`)
      } catch (e: any) {
        console.log(`${ansi.dim}Cannot branch: ${e.message}${ansi.reset}`)
      }
      return true
    }

    case '/branches': {
      try {
        const branches = listBranches(conversation.id)
        if (branches.length === 0) {
          console.log(`${ansi.dim}No branches found.${ansi.reset}`)
          return true
        }
        const lines = [`${ansi.bold}Branches of ${conversation.id}:${ansi.reset}`, '']
        for (const b of branches) {
          const name = b.branchName ? ` [${b.branchName}]` : ''
          const date = new Date(b.updatedAt).toISOString().slice(0, 10)
          lines.push(`  ${b.id}${name}  ${b.turns.length} msgs  ${ansi.dim}${date}${ansi.reset}`)
        }
        console.log(lines.join('\n'))
      } catch (e: any) {
        console.log(`${ansi.dim}Cannot list branches: ${e.message}${ansi.reset}`)
      }
      return true
    }

    case '/tag': {
      const parts = arg.split(/\s+/)
      const sub = parts[0]?.toLowerCase()
      const value = parts.slice(1).join(' ')

      if (sub === 'add' && value) {
        try {
          // Auto-save before tagging
          autoSaveSession(conversation)
          const ok = addSessionTag(conversation.id, value)
          console.log(ok ? `Tagged "${value}"` : `${ansi.dim}Tag "${value}" already exists${ansi.reset}`)
        } catch (e: any) {
          console.log(`${ansi.dim}Cannot add tag: ${e.message}${ansi.reset}`)
        }
        return true
      }
      if (sub === 'remove' && value) {
        try {
          const ok = removeSessionTag(conversation.id, value)
          console.log(ok ? `Removed tag "${value}"` : `${ansi.dim}Tag "${value}" not found${ansi.reset}`)
        } catch (e: any) {
          console.log(`${ansi.dim}Cannot remove tag: ${e.message}${ansi.reset}`)
        }
        return true
      }
      if (sub === 'list') {
        const tags = getSessionTags(conversation.id)
        console.log(tags.length ? `Tags: ${tags.join(', ')}` : `${ansi.dim}No tags${ansi.reset}`)
        return true
      }
      if (sub === 'search' && value) {
        try {
          const results = findSessionsByTag(value)
          if (results.length === 0) {
            console.log(`${ansi.dim}No sessions tagged "${value}"${ansi.reset}`)
            return true
          }
          const lines = [`${ansi.bold}Sessions tagged "${value}" (${results.length}):${ansi.reset}`, '']
          for (const s of results) {
            lines.push(`  ${s.id}  ${s.model}  ${s.turns.length} msgs`)
          }
          console.log(lines.join('\n'))
        } catch (e: any) {
          console.log(`${ansi.dim}Cannot search tags: ${e.message}${ansi.reset}`)
        }
        return true
      }
      console.log(`${ansi.dim}Usage: /tag add|remove|list|search <value>${ansi.reset}`)
      return true
    }

    case '/compress': {
      const parts = arg.split(/\s+/)
      let trimMode = false
      let keepLast = 10

      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === '--trim') {
          trimMode = true
          const n = parseInt(parts[i + 1] ?? '', 10)
          if (!isNaN(n) && n > 0) { keepLast = n; i++ }
        }
      }

      try {
        // Auto-save before compressing
        autoSaveSession(conversation)
        if (trimMode) {
          const result = trimSessionTurns(conversation.id, keepLast)
          console.log(`Compressed: ${result.originalMessages} → ${result.compressedMessages} messages (trim, kept last ${keepLast})`)
          console.log(`Backup: ${result.backupPath}`)
        } else {
          const proxyUrl = opts?.apiBaseUrl ?? 'http://127.0.0.1:8019'
          const result = await compressSessionNative(conversation.id, proxyUrl, conversation.model, keepLast)
          console.log(`Compressed: ${result.originalMessages} → ${result.compressedMessages} messages (LLM summary + last ${keepLast})`)
          console.log(`Backup: ${result.backupPath}`)
        }
      } catch (e: any) {
        console.log(`${ansi.dim}Compression failed: ${e.message}${ansi.reset}`)
      }
      return true
    }

    // ─── Round 55A: theme, thinking, rewind, context, plan, permissions, diff, memory, rename ──

    case '/theme':
    case '/themes': {
      if (!arg) {
        // Interactive theme picker
        const current = getThemeName()
        const themeDescriptions: Record<string, string> = {
          dark: 'Night vision — RGB palette',
          light: 'Day palette',
          'ansi-dark': 'Terminal-safe dark',
          'ansi-light': 'Terminal-safe light',
          'dark-daltonized': 'Colorblind-friendly dark',
          'light-daltonized': 'Colorblind-friendly light',
        }
        const pickerItems: PickerItem<string>[] = THEME_NAMES.map(name => ({
          label: name,
          description: name === current ? `(active) ${themeDescriptions[name] ?? ''}` : themeDescriptions[name],
          value: name,
        }))

        const result = await showPicker({
          title: '🎨 Select Theme',
          items: pickerItems,
          placeholder: 'Search themes…',
          visibleCount: 8,
          stream: process.stdout,
          readline: rl,
        })

        if (!result.cancelled && result.item) {
          setTheme(result.item.value as ThemeName)
          console.log(`${themeColor('success')}✓ Theme set to ${result.item.value}${sgr.reset}`)
        } else {
          console.log(dim('Theme selection cancelled.'))
        }
      } else {
        const name = arg.toLowerCase()
        if (THEME_NAMES.includes(name as any)) {
          setTheme(name as ThemeName)
          console.log(`${themeColor('success')}✓ Theme set to ${name}${sgr.reset}`)
        } else {
          console.log(`${ansi.red}Unknown theme: ${arg}${ansi.reset}. Available: ${THEME_NAMES.join(', ')}`)
        }
      }
      return true
    }

    case '/thinking': {
      if (!conversation.options) conversation.options = {}
      const ts = thinkingState ?? { mode: 'collapsed' as const, lastThinking: '' }
      if (!arg || arg === 'on') {
        conversation.options.thinking = true
        ts.mode = 'collapsed'
        console.log(`${themeColor('success')}✓ Extended thinking: ${ansi.bold}ON${sgr.reset} ${dim('(hidden by default — use /thinking show or /thinking verbose)')}`)
      } else if (arg === 'verbose') {
        conversation.options.thinking = true
        ts.mode = 'verbose'
        console.log(`${themeColor('success')}✓ Extended thinking: ${ansi.bold}VERBOSE${sgr.reset} ${dim('(full reasoning will be streamed)')}`)
      } else if (arg === 'off') {
        conversation.options.thinking = false
        ts.mode = 'collapsed'
        console.log(`${themeColor('warning')}● Extended thinking: OFF${sgr.reset}`)
      } else if (arg === 'show' || arg === 'last') {
        // Show last thinking block content
        if (ts.lastThinking) {
          console.log(`\n${sgr.italic}${ansi.dim}┌─ Last Thinking Block ───────────────────${sgr.reset}`)
          for (const line of ts.lastThinking.split('\n')) {
            console.log(`${sgr.italic}${ansi.dim}${line}${sgr.reset}`)
          }
          console.log(`${sgr.italic}${ansi.dim}└──────────────────────────── (${ts.lastThinking.length} chars)${sgr.reset}\n`)
        } else {
          console.log(dim('No thinking blocks recorded yet.'))
        }
      } else {
        const state = conversation.options?.thinking
          ? (ts.mode === 'verbose' ? 'VERBOSE' : 'ON')
          : 'OFF'
        console.log(`  Extended thinking: ${state}`)
        console.log(dim('  Usage: /thinking [on|off|verbose|show]'))
      }
      return true
    }

    case '/rewind': {
      const count = arg ? parseInt(arg, 10) : 1
      if (isNaN(count) || count < 1) {
        console.log(`${ansi.red}Usage: /rewind [N] — remove last N exchanges${ansi.reset}`)
        return true
      }
      let removedTurns = 0
      let removedExchanges = 0

      const removeLastExchange = (): number => {
        let removed = 0
        while (conversation.turns.length > 0) {
          const last = conversation.turns[conversation.turns.length - 1]!
          if (last.role === 'assistant') {
            conversation.turns.pop()
            removed++
          } else if (last.role === 'user' && removed > 0) {
            const isToolResult = Array.isArray(last.content) &&
              last.content.length > 0 &&
              typeof last.content[0] === 'object' &&
              'type' in last.content[0] &&
              last.content[0].type === 'tool_result'
            conversation.turns.pop()
            removed++
            if (!isToolResult) break
          } else {
            break
          }
        }
        return removed
      }

      for (let i = 0; i < count; i++) {
        const removed = removeLastExchange()
        if (removed === 0) break
        removedTurns += removed
        removedExchanges++
      }

      if (removedTurns === 0) {
        console.log(dim('Nothing to rewind'))
      } else {
        console.log(`${themeColor('success')}✓ Rewound ${removedExchanges} exchange(s) (${removedTurns} turns removed) — ${conversation.turns.length} turns remaining${sgr.reset}`)
      }
      conversation.turns = sanitizeConversationTurns(conversation.turns)
      return true
    }

    case '/context': {
      const { totalTokens, systemTokens, turnTokens } = estimateConversationTokens(conversation)
      const maxTokens = 200_000
      const pct = Math.round((totalTokens / maxTokens) * 100)
      const barWidth = 30
      const barColor = pct > 80 ? themeColor('error') : pct > 50 ? themeColor('warning') : themeColor('success')
      // Sub-character precision bar (8 steps per cell)
      const BLOCKS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█']
      const filled = (pct / 100) * barWidth
      const fullBlocks = Math.floor(filled)
      const partialIdx = Math.round((filled - fullBlocks) * 8)
      const bar = '█'.repeat(fullBlocks) + (BLOCKS[partialIdx] ?? '') + '░'.repeat(Math.max(0, barWidth - fullBlocks - 1))
      console.log(`\n  ${sgr.bold}Context Window${sgr.reset}`)
      console.log(`  ${barColor}${bar}${sgr.reset} ${pct}% (${(totalTokens / 1000).toFixed(1)}K / ${(maxTokens / 1000).toFixed(0)}K)`)
      console.log(`  Model: ${conversation.model}`)
      console.log('')

      // Per-category breakdown
      const sysK = (systemTokens / 1000).toFixed(1)
      console.log(`  ${sgr.bold}Breakdown${sgr.reset}`)
      console.log(`  ${dim(`System prompt:`)}  ~${sysK}K tokens`)

      // Per-turn analysis
      let userTokens = 0, assistantTokens = 0, toolTokens = 0
      for (let i = 0; i < conversation.turns.length; i++) {
        const turn = conversation.turns[i]!
        for (const block of turn.content) {
          const b = block as unknown as Record<string, unknown>
          const toks = b.type === 'text' && typeof b.text === 'string'
            ? estimateTokens(b.text)
            : b.type === 'tool_result' && typeof b.content === 'string'
              ? estimateTokens(b.content)
              : b.type === 'tool_use' && b.input
                ? estimateTokens(JSON.stringify(b.input))
                : 0
          if (turn.role === 'user') {
            if (b.type === 'tool_result') toolTokens += toks
            else userTokens += toks
          } else {
            if (b.type === 'tool_use') toolTokens += toks
            else assistantTokens += toks
          }
        }
      }
      console.log(`  ${dim(`User messages:`)}  ~${(userTokens / 1000).toFixed(1)}K tokens`)
      console.log(`  ${dim(`Assistant:`)}      ~${(assistantTokens / 1000).toFixed(1)}K tokens`)
      console.log(`  ${dim(`Tool I/O:`)}       ~${(toolTokens / 1000).toFixed(1)}K tokens`)
      console.log(`  ${dim(`Turns:`)}           ${conversation.turns.length}`)

      if (pct > 80) {
        console.log('')
        console.log(`  ${themeColor('warning')}⚠ High context usage — consider /compact to free space${sgr.reset}`)
      }
      console.log('')
      return true
    }

    case '/plan': {
      console.log(dim('Plan mode is managed via EnterPlanMode / ExitPlanMode tools.'))
      console.log(dim('The model will use plan mode automatically when appropriate.'))
      return true
    }

    case '/permissions': {
      const mode = approveState?.autoApprove ? 'auto-approve' : 'ask-before-execute'
      const globalPermsDisplay = loadPermissions()
      console.log(`\n  ${ansi.bold}Permissions${ansi.reset}`)
      console.log(`  Mode: ${mode === 'auto-approve' ? `${ansi.green}auto-approve${ansi.reset}` : `${ansi.yellow}ask-before-execute${ansi.reset}`}`)
      console.log(`  Toggle: /approve on|off`)
      if (globalPermsDisplay.size > 0) {
        console.log(`\n  ${ansi.bold}Always-approved tools:${ansi.reset}`)
        for (const t of [...globalPermsDisplay].sort()) {
          console.log(`    ${ansi.green}✓${ansi.reset} ${t}`)
        }
        console.log(dim(`\n  /permissions clear — remove all persistent approvals`))
      } else {
        console.log(dim(`\n  No tools in always-approve list.`))
        console.log(dim(`  When prompted, press 'a' to always-approve a tool.`))
      }

      if (arg === 'clear') {
        clearGlobalPermissions()
        const sessionPerms = conversation.options?.alwaysApprove
        if (sessionPerms) sessionPerms.clear()
        console.log(`${ansi.green}✓${ansi.reset} Cleared all persistent tool permissions.`)
      }
      console.log('')
      return true
    }

    case '/diff': {
      try {
        const cwd = process.cwd()
        // Check if we're in a git repository
        try {
          execSync('git rev-parse --is-inside-work-tree', { cwd, stdio: 'pipe' })
        } catch {
          console.log(dim('Not inside a git repository.'))
          return true
        }

        // /diff <file> — show detailed diff for a specific file
        if (arg) {
          const fileDiff = execSync(
            `git diff --no-color -- ${JSON.stringify(arg)} 2>/dev/null; git diff --cached --no-color -- ${JSON.stringify(arg)} 2>/dev/null`,
            { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 },
          ).trim()
          if (!fileDiff) {
            console.log(dim(`No changes for: ${arg}`))
            return true
          }
          // Render colored diff output
          console.log('')
          const diffLines = fileDiff.split('\n')
          let lineCount = 0
          const maxDiffLines = 400 // keep diff output bounded
          for (const dl of diffLines) {
            if (lineCount >= maxDiffLines) {
              console.log(dim(`  … (${diffLines.length - maxDiffLines} more lines truncated)`))
              break
            }
            if (dl.startsWith('+++') || dl.startsWith('---')) {
              console.log(`  ${sgr.bold}${dl}${sgr.reset}`)
            } else if (dl.startsWith('@@')) {
              console.log(`  ${themeColor('info')}${dl}${sgr.reset}`)
            } else if (dl.startsWith('+')) {
              console.log(`  ${themeColor('success')}${dl}${sgr.reset}`)
            } else if (dl.startsWith('-')) {
              console.log(`  ${themeColor('error')}${dl}${sgr.reset}`)
            } else {
              console.log(`  ${dim(dl)}`)
            }
            lineCount++
          }
          console.log('')
          return true
        }

        // /diff — summary view (all files)
        // Get unstaged changes (working tree vs index)
        const unstagedRaw = execSync('git diff --stat --no-color 2>/dev/null || true', { cwd, encoding: 'utf8' }).trim()
        // Get staged changes (index vs HEAD)
        const stagedRaw = execSync('git diff --cached --stat --no-color 2>/dev/null || true', { cwd, encoding: 'utf8' }).trim()

        if (!unstagedRaw && !stagedRaw) {
          console.log(dim('No uncommitted changes.'))
          return true
        }

        const parseDiffStat = (raw: string): Array<{ file: string; added: number; removed: number }> => {
          if (!raw) return []
          const lines = raw.split('\n')
          const results: Array<{ file: string; added: number; removed: number }> = []
          for (const line of lines) {
            // Format: " path/to/file | 5 +++--" or " path/to/file | Bin 0 -> 1234 bytes"
            const m = line.match(/^\s*(.+?)\s+\|\s+(\d+)/)
            if (m) {
              const file = m[1].trim()
              const plusMatch = line.match(/(\d+)\s+insertion/)
              const minusMatch = line.match(/(\d+)\s+deletion/)
              // Alternative: count + and - symbols
              const symMatch = line.match(/\|\s+\d+\s+(\++)?(-+)?$/)
              const added = plusMatch ? parseInt(plusMatch[1]) : (symMatch?.[1]?.length ?? 0)
              const removed = minusMatch ? parseInt(minusMatch[1]) : (symMatch?.[2]?.length ?? 0)
              results.push({ file, added, removed })
            }
          }
          return results
        }

        console.log('')

        if (stagedRaw) {
          const staged = parseDiffStat(stagedRaw)
          console.log(`  ${sgr.bold}Staged Changes${sgr.reset}`)
          for (const f of staged) {
            const adds = f.added > 0 ? `${themeColor('success')}+${f.added}${sgr.reset}` : ''
            const dels = f.removed > 0 ? `${themeColor('error')}-${f.removed}${sgr.reset}` : ''
            console.log(`    ${f.file}  ${adds} ${dels}`)
          }
          console.log('')
        }

        if (unstagedRaw) {
          const unstaged = parseDiffStat(unstagedRaw)
          console.log(`  ${sgr.bold}Unstaged Changes${sgr.reset}`)
          for (const f of unstaged) {
            const adds = f.added > 0 ? `${themeColor('success')}+${f.added}${sgr.reset}` : ''
            const dels = f.removed > 0 ? `${themeColor('error')}-${f.removed}${sgr.reset}` : ''
            console.log(`    ${f.file}  ${adds} ${dels}`)
          }
          console.log('')
        }

        // Summary line
        const totalFiles = new Set([
          ...parseDiffStat(stagedRaw).map(f => f.file),
          ...parseDiffStat(unstagedRaw).map(f => f.file),
        ]).size
        const allStats = [...parseDiffStat(stagedRaw), ...parseDiffStat(unstagedRaw)]
        const totalAdded = allStats.reduce((s, f) => s + f.added, 0)
        const totalRemoved = allStats.reduce((s, f) => s + f.removed, 0)
        console.log(dim(`  ${totalFiles} file${totalFiles !== 1 ? 's' : ''} changed  ${themeColor('success')}+${totalAdded}${sgr.reset} ${themeColor('error')}-${totalRemoved}${sgr.reset}`))
        console.log(dim(`  Tip: /diff <file> to see detailed changes for a specific file`))
        console.log('')
      } catch (e) {
        console.log(`${themeColor('error')}Error reading diff: ${e instanceof Error ? e.message : String(e)}${sgr.reset}`)
      }
      return true
    }

    case '/init': {
      const cwd = process.cwd()
      const owlFile = join(cwd, 'OWLCODA.md')

      if (existsSync(owlFile)) {
        const stat = statSync(owlFile)
        console.log(`\n  ${themeColor('warning')}⚠${sgr.reset} OWLCODA.md already exists (${(stat.size / 1024).toFixed(1)}KB)`)
        console.log(dim('  Edit it directly to update project instructions.'))
        console.log('')
        return true
      }

      // Detect project info for template generation
      let projectName = cwd.split('/').pop() ?? 'project'
      let lang = ''
      let buildCmd = ''
      let testCmd = ''

      if (existsSync(join(cwd, 'package.json'))) {
        try {
          const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
          projectName = pkg.name ?? projectName
          lang = 'TypeScript/JavaScript'
          if (pkg.scripts?.build) buildCmd = `npm run build`
          if (pkg.scripts?.test) testCmd = `npm test`
        } catch { /* ignore parse errors */ }
      } else if (existsSync(join(cwd, 'Cargo.toml'))) {
        lang = 'Rust'
        buildCmd = 'cargo build'
        testCmd = 'cargo test'
      } else if (existsSync(join(cwd, 'go.mod'))) {
        lang = 'Go'
        buildCmd = 'go build ./...'
        testCmd = 'go test ./...'
      } else if (existsSync(join(cwd, 'requirements.txt')) || existsSync(join(cwd, 'pyproject.toml'))) {
        lang = 'Python'
        testCmd = 'pytest'
      }

      const lines: string[] = [
        `# OWLCODA.md`,
        ``,
        `This file provides guidance to OwlCoda when working with code in this repository.`,
        ``,
      ]

      if (lang) {
        lines.push(`## Project`, ``, `- Language: ${lang}`, ``)
      }

      if (buildCmd || testCmd) {
        lines.push(`## Commands`, ``)
        if (buildCmd) lines.push(`- Build: \`${buildCmd}\``)
        if (testCmd) lines.push(`- Test: \`${testCmd}\``)
        lines.push(``)
      }

      lines.push(
        `## Style`,
        ``,
        `<!-- Add project-specific coding conventions here -->`,
        ``,
      )

      writeFileSync(owlFile, lines.join('\n'), 'utf8')
      console.log(`\n  ${themeColor('success')}✓${sgr.reset} Created ${sgr.bold}OWLCODA.md${sgr.reset} in ${cwd}`)
      console.log(dim('  Edit this file to add project-specific instructions for the assistant.'))
      console.log('')
      return true
    }

    case '/memory': {
      const cwd = process.cwd()
      const candidates = ['OWLCODA.md', '.owlcoda/OWLCODA.md']
      const found: Array<{ name: string; size: number }> = []

      // Search from cwd upward to git root (matching system prompt loader)
      let dir = cwd
      const seen = new Set<string>()
      for (let depth = 0; depth < 6; depth++) {
        for (const c of candidates) {
          const p = join(dir, c)
          if (seen.has(p)) continue
          seen.add(p)
          try {
            const stat = statSync(p)
            if (stat.isFile() && stat.size > 0) {
              const label = depth === 0 ? c : join(basename(dir), c)
              found.push({ name: label, size: stat.size })
            }
          } catch { /* not found */ }
        }
        if (existsSync(join(dir, '.git'))) break
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }

      if (found.length === 0) {
        console.log(dim('No memory files found.'))
        console.log(dim('Create OWLCODA.md in your project to add persistent context.'))
      } else {
        console.log(`\n  ${ansi.bold}Memory Files${ansi.reset} (loaded into system prompt)\n`)
        for (const f of found) {
          console.log(`  ${themeColor('success')}●${sgr.reset} ${f.name} ${dim(`(${(f.size / 1024).toFixed(1)}KB)`)}`)
        }
        console.log()
      }
      return true
    }

    case '/rename': {
      if (!arg) {
        console.log(`${ansi.red}Usage: /rename <title>${ansi.reset}`)
        return true
      }
      if (!conversation.options) conversation.options = {}
      conversation.options.title = arg
      console.log(`${themeColor('success')}✓ Session renamed to: ${arg}${sgr.reset}`)
      return true
    }

    case '/version':
      console.log(`OwlCoda v${VERSION}`)
      return true

    case '/files': {
      // List files mentioned in conversation context (tool uses)
      const mentioned = new Set<string>()
      for (const turn of conversation.turns) {
        for (const block of turn.content) {
          if (block.type === 'tool_use') {
            const inp = block.input as Record<string, unknown>
            const path = inp['path'] ?? inp['file_path'] ?? inp['filename']
            if (typeof path === 'string') mentioned.add(path)
          }
        }
      }
      if (mentioned.size === 0) {
        console.log(dim('No files referenced in this session yet.'))
      } else {
        console.log(`${sgr.bold}Files in context (${mentioned.size}):${sgr.reset}`)
        for (const f of [...mentioned].sort()) {
          console.log(`  ${themeColor('info')}${f}${sgr.reset}`)
        }
      }
      return true
    }

    case '/stats': {
      const snap = usage.getSnapshot()
      const turnCount = conversation.turns.length
      const userTurns = conversation.turns.filter(t => t.role === 'user').length
      const assistantTurns = conversation.turns.filter(t => t.role === 'assistant').length
      const toolUses = conversation.turns.reduce((acc, t) => {
        return acc + t.content.filter(b => b.type === 'tool_use').length
      }, 0)
      console.log(`${sgr.bold}Session Statistics${sgr.reset}`)
      console.log(`  Turns:       ${turnCount} (${userTurns} user, ${assistantTurns} assistant)`)
      console.log(`  Tool uses:   ${toolUses}`)
      console.log(`  Input tokens:  ${snap.totalInputTokens.toLocaleString()}`)
      console.log(`  Output tokens: ${snap.totalOutputTokens.toLocaleString()}`)
      if (snap.estimatedCostUsd > 0) {
        console.log(`  Estimated cost: $${snap.estimatedCostUsd.toFixed(4)}`)
      }
      console.log(`  Model: ${conversation.model}`)
      console.log(`  Session: ${conversation.id}`)
      return true
    }

    case '/brief': {
      if (!conversation.options) conversation.options = {}
      const current = conversation.options.brief ?? false
      if (arg === 'on' || arg === 'off') {
        conversation.options.brief = arg === 'on'
      } else {
        conversation.options.brief = !current
      }
      const isOn = conversation.options.brief
      rebuildSystemPrompt(conversation)
      console.log(`${themeColor(isOn ? 'success' : 'info')}Brief mode: ${isOn ? 'ON' : 'OFF'}${sgr.reset}`)
      if (isOn) {
        console.log(dim('  Responses will be more concise.'))
      }
      return true
    }

    case '/fast': {
      if (!conversation.options) conversation.options = {}
      const current = conversation.options.fast ?? false
      if (arg === 'on' || arg === 'off') {
        conversation.options.fast = arg === 'on'
      } else {
        conversation.options.fast = !current
      }
      const isOn = conversation.options.fast
      rebuildSystemPrompt(conversation)
      console.log(`${themeColor(isOn ? 'success' : 'info')}Fast mode: ${isOn ? 'ON' : 'OFF'}${sgr.reset}`)
      if (isOn) {
        console.log(dim('  Prioritizing speed over depth.'))
      }
      return true
    }

    case '/effort': {
      const levels = ['low', 'medium', 'high']
      if (!conversation.options) conversation.options = {}
      if (arg && levels.includes(arg.toLowerCase())) {
        conversation.options.effort = arg.toLowerCase()
        rebuildSystemPrompt(conversation)
        console.log(`${themeColor('success')}✓ Effort level: ${arg.toLowerCase()}${sgr.reset}`)
      } else {
        const current = conversation.options.effort ?? 'high'
        console.log(`${sgr.bold}Effort level:${sgr.reset} ${current}`)
        console.log(dim(`  Usage: /effort <low|medium|high>`))
      }
      return true
    }

    case '/color': {
      if (!arg) {
        console.log(`${sgr.bold}Prompt color:${sgr.reset} ${themeColor('owl')}current${sgr.reset}`)
        console.log(dim('  Usage: /color <theme-name>  (same as /theme)'))
        return true
      }
      // Delegate to /theme
      return handleSlashCommand(`/theme ${arg}`, conversation, usage, opts, approveState, dispatcher, statusBar, toolCollector, rl, mcpManager, thinkingState, output)
    }

    case '/vim': {
      if (!conversation.options) conversation.options = {}
      const current = conversation.options.vimMode ?? false
      conversation.options.vimMode = !current
      console.log(`${themeColor(conversation.options.vimMode ? 'success' : 'info')}Vim mode: ${conversation.options.vimMode ? 'ON' : 'OFF'}${sgr.reset}`)
      if (conversation.options.vimMode) {
        console.log(dim('  Note: Vim keybindings require terminal support.'))
      }
      return true
    }

    case '/btw': {
      if (!arg) {
        console.log(`${ansi.red}Usage: /btw <quick question>${ansi.reset}`)
        console.log(dim('  Ask a side question without interrupting the main conversation.'))
        return true
      }
      if (!opts || !dispatcher) {
        console.log(dim('Side questions require an active API connection.'))
        return true
      }
      // Side question — send to model in a temporary context (doesn't affect main conversation)
      console.log(`${dim('  (side question)')}\n`)
      try {
        const sideMd = new StreamingMarkdownRenderer()
        const sideConvo: Conversation = {
          id: `btw-${Date.now()}`,
          system: 'You are a helpful assistant. Answer briefly and directly.',
          turns: [{ role: 'user' as const, content: [{ type: 'text' as const, text: arg }], timestamp: Date.now() }],
          tools: [],
          model: conversation.model,
          maxTokens: conversation.maxTokens,
        }
        const sideAbort = new AbortController()
        const { finalText, usage: sideUsage, stopReason, runtimeFailure } = await runConversationLoop(sideConvo, dispatcher!, {
          apiBaseUrl: opts?.apiBaseUrl ?? 'http://127.0.0.1:8019',
          apiKey: opts?.apiKey ?? 'local',
          maxIterations: 1,
          requestTimeoutMs: 60_000, // 60s timeout for side questions (shorter than main 180s)
          callbacks: {
            onText(text) {
              const rendered = safeRender(() => sideMd.push(text), text)
              if (rendered) writeSlashOutput(output, rendered)
            },
            onError(error) { console.error(formatError(parseApiError(error))) },
          },
          signal: sideAbort.signal,
        })
        const flushed = safeRender(() => sideMd.flush())
        if (flushed) writeSlashOutput(output, flushed)
        if (finalText) writeSlashOutput(output, '\n')
        else if (shouldShowNoResponseFallback({
          finalText,
          stopReason,
          runtimeFailure,
          aborted: sideAbort.signal.aborted,
        })) console.log(dim('(No response from model)'))
        if (sideUsage.inputTokens > 0 || sideUsage.outputTokens > 0) {
          console.log(formatUsage(sideUsage.inputTokens, sideUsage.outputTokens))
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`${ansi.red}✗ ${parseApiError(msg)}${ansi.reset}`)
      }
      return true
    }

    case '/commit': {
      try {
        const status = execSync('git status --porcelain', { encoding: 'utf8', timeout: 5000 }).trim()
        if (!status) {
          console.log(dim('No changes to commit.'))
          return true
        }
        console.log(`${sgr.bold}Staged/unstaged changes:${sgr.reset}`)
        console.log(`  ${status.split('\n').join('\n  ')}`)
        if (arg) {
          execSync(`git add -A && git commit -m "${arg.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 10000 })
          console.log(`${themeColor('success')}✓ Committed: ${arg}${sgr.reset}`)
        } else {
          console.log(dim('\n  Usage: /commit <message>  — to commit all changes'))
        }
      } catch (e: any) {
        console.log(`${themeColor('error')}Git error: ${e.message?.split('\n')[0] ?? 'unknown'}${sgr.reset}`)
      }
      return true
    }

    case '/release-notes':
      console.log(`${sgr.bold}OwlCoda v${VERSION} Release Notes${sgr.reset}\n`)
      console.log(`  ${themeColor('success')}Highlights:${sgr.reset}`)
      console.log(`  • MCP client: stdio transport, auto-connect, /mcp + /skills`)
      console.log(`  • Extended thinking: /thinking verbose streams full reasoning`)
      console.log(`  • Project memory: auto-loads OWLCODA.md into system prompt`)
      console.log(`  • /pr-comments and /review via GitHub CLI`)
      console.log(`  • Model filtering: /model only shows available models`)
      console.log(`  • Preflight collapse: clean startup with fewer warnings`)
      console.log(`  • Cloud SSE fix: proper data framing for cloud model streaming`)
      console.log(`  • Markdown: HR/bracket/bold structural breaks`)
      console.log(`  • /btw side questions with 60s timeout`)
      console.log(`  • Thinking API wiring: /thinking on keeps reasoning hidden unless you ask for it`)
      console.log(``)
      console.log(`  ${dim('Previous (v0.7.0):')}`)
      console.log(`  • /doctor diagnostics · /context breakdown · /btw side questions`)
      console.log(`  • Request timeout · JSON pretty-print · Bash progress`)
      console.log(`  • 42 native tools, 69+ slash commands`)
      console.log(`\n${dim(`Full changelog: owlcoda --release-notes`)}`)
      return true

    case '/skills': {
      // MCP-backed skills listing
      const allTools = mcpManager?.getAllTools() ?? []
      if (allTools.length === 0) {
        console.log(dim('No MCP skills available.'))
        if (!mcpManager || mcpManager.getServers().length === 0) {
          console.log(dim('Configure MCP servers in .mcp.json or ~/.owlcoda/mcp.json'))
        }
      } else {
        console.log(`\n  ${ansi.bold}MCP Skills${ansi.reset} (${allTools.length})\n`)
        const byServer = new Map<string, typeof allTools>()
        for (const entry of allTools) {
          const list = byServer.get(entry.server) ?? []
          list.push(entry)
          byServer.set(entry.server, list)
        }
        for (const [server, tools] of byServer) {
          console.log(`  ${themeColor('info')}${server}${sgr.reset}`)
          for (const { tool } of tools) {
            const desc = tool.description ? dim(` — ${tool.description.slice(0, 60)}`) : ''
            console.log(`    ${tool.name}${desc}`)
          }
        }
        console.log()
      }

      // File-based skills
      const projectSkillDir = join(process.cwd(), '.owlcoda', 'skills')
      const userSkillDir = join(homedir(), '.owlcoda', 'skills')

      console.log(`\n  ${ansi.bold}File-based Skills${ansi.reset}\n`)
      let foundFileSkills = false

      for (const [label, dir] of [['Project', projectSkillDir], ['User', userSkillDir]] as const) {
        try {
          const files = readdirSync(dir).filter((f: string) => f.endsWith('.md') || f.endsWith('.txt'))
          if (files.length > 0) {
            foundFileSkills = true
            for (const f of files) {
              const skillName = basename(f, f.endsWith('.md') ? '.md' : '.txt')
              console.log(`  ${themeColor('success')}●${sgr.reset} ${skillName} ${dim(`(${label.toLowerCase()})`)}`)
            }
          }
        } catch { /* dir doesn't exist */ }
      }

      if (!foundFileSkills) {
        console.log(dim('  No file-based skills found. Add .md files to .owlcoda/skills/'))
      }
      console.log()

      // Curated (learned) skills from the skills library
      try {
        const { loadCuratedSkills } = await import('../skills/curated.js')
        const { loadLearnedSkills } = await import('../skills/store.js')
        const curated = await loadCuratedSkills()
        const learned = await loadLearnedSkills()
        if (curated.length > 0 || learned.length > 0) {
          console.log(`  ${ansi.bold}Skill Library${ansi.reset}\n`)
          if (curated.length > 0) {
            console.log(`  ${themeColor('success')}●${sgr.reset} ${curated.length} curated skills available`)
          }
          if (learned.length > 0) {
            console.log(`  ${themeColor('info')}●${sgr.reset} ${learned.length} learned skill${learned.length > 1 ? 's' : ''} from your sessions`)
          }
          console.log(dim(`\n  Run 'owlcoda skills stats' for details, 'owlcoda skills search <query>' to find skills.\n`))
        }
      } catch { /* curated/learned skills not available */ }

      return true
    }

    case '/tasks':
      console.log(dim('Background tasks not yet available in native mode.'))
      console.log(dim('Use /status to view current session state.'))
      return true

    case '/mcp': {
      const servers = mcpManager?.getServers() ?? []
      console.log(renderMcpPanel(servers, process.stdout.columns))

      if (arg === 'reconnect' || arg === 'connect') {
        console.log(dim('\n  Reconnecting...'))
        mcpManager?.disconnectAll().then(() => mcpManager.connectAll()).then((states) => {
          const ok = states.filter((s) => s.status === 'connected').length
          console.log(`  ${themeColor('success')}✓ ${ok}/${states.length} connected${sgr.reset}`)
        }).catch((e: Error) => console.log(`  ${ansi.red}Error: ${e.message}${ansi.reset}`))
      }
      return true
    }

    case '/hooks':
      console.log(dim('Hook configurations not yet available in native mode.'))
      return true

    case '/pr-comments': {
      if (!arg) {
        console.log(`${ansi.red}Usage: /pr-comments <pr-number>${ansi.reset}`)
        return true
      }
      const prNum = arg.replace('#', '').trim()
      if (!/^\d+$/.test(prNum)) {
        console.log(`${ansi.red}Invalid PR number: ${arg}${ansi.reset}`)
        return true
      }
      try {
        // Fetch PR info and review comments via gh CLI
        const prInfo = execSync(
          `gh pr view ${prNum} --json title,state,author,url,reviewDecision,additions,deletions,changedFiles 2>&1`,
          { encoding: 'utf8', timeout: 15000 },
        )
        const pr = JSON.parse(prInfo)
        console.log(`\n  ${ansi.bold}PR #${prNum}: ${pr.title}${ansi.reset}`)
        console.log(`  ${dim(`by ${pr.author?.login ?? '?'} · ${pr.state} · +${pr.additions}/-${pr.deletions} in ${pr.changedFiles} files`)}`)
        if (pr.reviewDecision) console.log(`  ${dim(`Review: ${pr.reviewDecision}`)}`)
        console.log(`  ${dim(pr.url)}`)

        // Fetch review comments
        const commentsJson = execSync(
          `gh pr view ${prNum} --json comments,reviews --jq '.reviews[] | select(.body != "") | {author: .author.login, state: .state, body: .body}' 2>&1`,
          { encoding: 'utf8', timeout: 15000 },
        ).trim()

        if (commentsJson) {
          console.log(`\n  ${ansi.bold}Reviews:${ansi.reset}`)
          for (const line of commentsJson.split('\n')) {
            try {
              const review = JSON.parse(line)
              const stateIcon = review.state === 'APPROVED' ? `${ansi.green}✓${ansi.reset}` :
                review.state === 'CHANGES_REQUESTED' ? `${ansi.red}✗${ansi.reset}` : `${ansi.yellow}◌${ansi.reset}`
              console.log(`  ${stateIcon} ${review.author}: ${review.body.slice(0, 120)}`)
            } catch { /* skip malformed */ }
          }
        }

        // Fetch inline review comments
        const inlineJson = execSync(
          `gh api repos/{owner}/{repo}/pulls/${prNum}/comments --jq '.[] | {path: .path, line: .line, body: .body, user: .user.login}' 2>&1`,
          { encoding: 'utf8', timeout: 15000 },
        ).trim()

        if (inlineJson) {
          console.log(`\n  ${ansi.bold}Inline Comments:${ansi.reset}`)
          let count = 0
          for (const line of inlineJson.split('\n')) {
            if (count >= 20) { console.log(dim(`  ... and more`)); break }
            try {
              const c = JSON.parse(line)
              console.log(`  ${dim(`${c.path}:${c.line}`)} ${c.user}: ${c.body.split('\n')[0].slice(0, 100)}`)
              count++
            } catch { /* skip */ }
          }
        }
        console.log()
      } catch (err: unknown) {
        const msg = err instanceof Error ? (err as { stderr?: string }).stderr || err.message : String(err)
        if (msg.includes('not found') || msg.includes('Could not resolve')) {
          console.log(dim('Not in a git repository with a GitHub remote.'))
        } else if (msg.includes('gh: command not found') || msg.includes('ENOENT')) {
          console.log(dim('GitHub CLI (gh) not installed. Install: https://cli.github.com'))
        } else {
          console.log(`${ansi.red}Error: ${msg.split('\n')[0]}${ansi.reset}`)
        }
      }
      return true
    }

    case '/review': {
      if (!arg) {
        console.log(`${ansi.red}Usage: /review <pr-number> [approve|request-changes|comment]${ansi.reset}`)
        return true
      }
      const reviewParts = arg.split(/\s+/)
      const reviewPrNum = reviewParts[0]!.replace('#', '')
      const reviewAction = reviewParts[1]?.toLowerCase() ?? 'view'

      if (!/^\d+$/.test(reviewPrNum)) {
        console.log(`${ansi.red}Invalid PR number: ${reviewParts[0]}${ansi.reset}`)
        return true
      }

      try {
        if (reviewAction === 'view' || !reviewParts[1]) {
          // Show PR diff summary
          const diffStat = execSync(
            `gh pr diff ${reviewPrNum} --stat 2>&1`,
            { encoding: 'utf8', timeout: 15000 },
          ).trim()
          console.log(`\n  ${ansi.bold}PR #${reviewPrNum} Changes:${ansi.reset}\n`)
          for (const line of diffStat.split('\n').slice(0, 30)) {
            console.log(`  ${line}`)
          }
          console.log(`\n  ${dim('Actions: /review ' + reviewPrNum + ' approve|request-changes|comment')}`)
        } else if (reviewAction === 'approve') {
          execSync(`gh pr review ${reviewPrNum} --approve`, { encoding: 'utf8', timeout: 15000 })
          console.log(`${ansi.green}✓ Approved PR #${reviewPrNum}${ansi.reset}`)
        } else if (reviewAction === 'request-changes' || reviewAction === 'changes') {
          const body = reviewParts.slice(2).join(' ') || 'Changes requested.'
          execSync(`gh pr review ${reviewPrNum} --request-changes --body "${body.replace(/"/g, '\\"')}"`,
            { encoding: 'utf8', timeout: 15000 })
          console.log(`${ansi.yellow}✗ Requested changes on PR #${reviewPrNum}${ansi.reset}`)
        } else if (reviewAction === 'comment') {
          const body = reviewParts.slice(2).join(' ') || 'Review comment.'
          execSync(`gh pr review ${reviewPrNum} --comment --body "${body.replace(/"/g, '\\"')}"`,
            { encoding: 'utf8', timeout: 15000 })
          console.log(`${themeColor('info')}◌ Commented on PR #${reviewPrNum}${sgr.reset}`)
        } else {
          console.log(`${ansi.red}Unknown action: ${reviewAction}${ansi.reset}`)
          console.log(dim('  Actions: approve, request-changes, comment'))
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? (err as { stderr?: string }).stderr || err.message : String(err)
        if (msg.includes('gh: command not found') || msg.includes('ENOENT')) {
          console.log(dim('GitHub CLI (gh) not installed. Install: https://cli.github.com'))
        } else {
          console.log(`${ansi.red}Error: ${msg.split('\n')[0]}${ansi.reset}`)
        }
      }
      return true
    }

    case '/add-dir': {
      if (!arg) {
        console.log(`${ansi.red}Usage: /add-dir <path>${ansi.reset}`)
        return true
      }
      try {
        const resolved = resolve(arg)
        if (existsSync(resolved) && statSync(resolved).isDirectory()) {
          if (!conversation.options) conversation.options = {}
          if (!conversation.options.additionalDirs) conversation.options.additionalDirs = []
          if (!conversation.options.additionalDirs.includes(resolved)) {
            conversation.options.additionalDirs.push(resolved)
          }
          console.log(`${themeColor('success')}✓ Added directory: ${resolved}${sgr.reset}`)
        } else {
          console.log(`${themeColor('error')}Directory not found: ${arg}${sgr.reset}`)
        }
      } catch (e: any) {
        console.log(`${themeColor('error')}Error: ${e.message}${sgr.reset}`)
      }
      return true
    }

    case '/login': {
      // Show cloud model API key status or set key for a model
      if (!opts) {
        console.log(dim('No server connection available.'))
        return true
      }

      if (!arg) {
        // Show status of all endpoint (cloud) models
        try {
          const truth = await fetchAdminModelTruth(opts, { skipCache: true })
          const cloudModels = truth.statuses.filter(status => status.providerKind === 'cloud' && status.raw.config?.endpoint)
            if (cloudModels.length === 0) {
              console.log(dim('No cloud endpoint models configured.'))
              console.log(dim('Add endpoint models to your config.json to use cloud providers.'))
            } else {
              console.log(`\n  ${sgr.bold}Cloud Model API Keys${sgr.reset}\n`)
              for (const m of cloudModels) {
                const hasKey = !!m.raw.config?.apiKey || !!m.raw.config?.apiKeyEnv
                const icon = hasKey ? `${ansi.green}✓${ansi.reset}` : `${ansi.red}✗${ansi.reset}`
                const endpoint = dim(` → ${m.raw.config?.endpoint}`)
                const credential = m.raw.config?.apiKeyEnv
                  ? dim(` (env: ${m.raw.config.apiKeyEnv})`)
                  : hasKey
                    ? dim(' (inline key)')
                    : dim(' (missing key)')
                console.log(`  ${icon} ${m.id}${endpoint}${credential}`)
              }
              console.log(`\n  ${dim('Set a key:')} /login <model-id> <api-key>`)
              console.log(`  ${dim('Keys are saved to your config file.')}\n`)
            }
        } catch {
          console.log(dim('Could not connect to server to check API keys.'))
        }
        return true
      }

      // Set API key: /login <model-id> <api-key>
      const parts = arg.split(/\s+/)
      if (parts.length < 2) {
        console.log(`${ansi.yellow}Usage: /login <model-id> <api-key>${ansi.reset}`)
        console.log(dim('  Example: /login minimax-m27 sk-abc123...'))
        return true
      }
      const modelId = parts[0]!
      const apiKeyVal = parts.slice(1).join(' ')

      try {
        const mutator = new ModelConfigMutator({ configPath: getOwlcodaConfigPath() })
        await mutator.setApiKey(modelId, apiKeyVal)
        console.log(`${themeColor('success')}✓ API key set for ${modelId}${sgr.reset}`)
        console.log(dim('  Config saved. Server truth cache will refresh on config reload.'))
      } catch (e: any) {
        console.log(`${ansi.red}Error updating config: ${e.message}${ansi.reset}`)
      }
      return true
    }

    case '/quit':
    case '/exit':
      statusBar?.uninstall()
      if (conversation.turns.length > 0) {
        saveSession(conversation)
        console.log(`  ${dim('⎿')}  ${themeColor('owl')}Bye!${sgr.reset}`)
        console.log(dim(`\nResume this session with:\n  owlcoda --resume ${conversation.id}\n`))
      } else {
        console.log(`  ${dim('⎿')}  ${themeColor('owl')}Bye!${sgr.reset}`)
      }
      process.exit(0)

    case '/why-native': {
      const owl = themeColor('owl')
      const s = themeColor('success')
      const r = sgr.reset
      const d = dim
      console.log(`
  ${owl}🦉 Why Native Mode?${r}

  OwlCoda's native mode is built for local-first AI coding.
  Here's what you get in the native product experience:

    ${s}✦${r} ${sgr.bold}42+ native tools${r}
      Every tool is a first-class TypeScript implementation with full test coverage.

    ${s}✦${r} ${sgr.bold}69+ slash commands${r}
      /dashboard, /model, /skills, /health, /budget, /training and more.

    ${s}✦${r} ${sgr.bold}Session persistence with CWD tracking${r}
      Save and resume conversations. We even warn you if the directory changed.

    ${s}✦${r} ${sgr.bold}Local model routing${r}
      Switch between Ollama, vLLM, and cloud providers with /model.

    ${s}✦${r} ${sgr.bold}Skill system${r}
      File-based and MCP-backed skills discoverable via /skills.

    ${s}✦${r} ${sgr.bold}Tool maturity labels${r}
      Every tool declares its maturity level (GA/Beta/Experimental).

    ${s}✦${r} ${sgr.bold}Full observability${r}
      /dashboard, /tokens, /health, /slo — real operational visibility.

    ${s}✦${r} ${sgr.bold}Local-first deployment${r}
      Local backends are first-class, with optional cloud models when you configure them.

  ${d('Type /help for all commands, or just start coding!')}
`)
      return true
    }

    default:
      console.log(`Unknown command: ${cmd}. Type /help for available commands.`)
      return true
  }
}
