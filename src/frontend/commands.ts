/**
 * Slash command handling for the legacy OwlCoda readline REPL.
 */

import type { OwlCodaConfig, ConfiguredModel } from '../config.js'
import { listConfiguredModels, getDefaultConfiguredModel, resolveConfiguredModel, resolveModelContextWindow } from '../config.js'
import { formatModelName, bold, dim, formatInfo, formatError } from './display.js'
import { CAPABILITIES, type CapabilityStatus } from '../capabilities.js'
import { runPreflight } from '../preflight.js'
import { VERSION } from '../version.js'
import { isTraceEnabled, setTraceEnabled, getTokenUsage } from '../trace.js'
import { getRecentErrors, getUptime, getErrorCount } from '../diagnostics.js'
import { getLoadedPlugins, loadPlugins } from '../plugins/index.js'
import { listSessions, loadSession, deleteSession, searchSessions, addSessionTag, removeSessionTag, findSessionsByTag, branchSession, listBranches } from '../history/sessions.js'
import { getMetrics } from '../observability.js'
import { getRateLimitStats } from '../middleware/rate-limit.js'
import { getAllCircuitStates, resetCircuitBreaker } from '../middleware/circuit-breaker.js'
import { readAuditLog } from '../audit.js'
import { getAllModelHealth } from '../health-monitor.js'
import { getAllBudgets, getSloTarget, resetBudgets } from '../error-budget.js'
import { getRecentTraces } from '../request-trace.js'
import { renderMetrics } from '../prometheus.js'
import { discoverBackends } from '../backends/discovery.js'
import type { DiscoveryResult } from '../backends/types.js'
import { estimateCost, formatCostBreakdown, getSessionCostSummary } from '../cost-estimator.js'
import { warmupModels, formatWarmupResults } from '../warmup.js'
import { formatAllPerfSummaries, getAllModelMetrics, getModelPerfSummary } from '../perf-tracker.js'
import { recommendModel, formatRecommendation, type Intent } from '../model-recommender.js'

export interface CommandContext {
  config: OwlCodaConfig
  currentModel: string
  sessionId: string | null
  messageCount: number
  autoApprove: boolean
  setModel: (model: string) => void
  setAutoApprove: (value: boolean) => void
  clearMessages: () => void
  quit: () => void
  resumeSession: (id: string) => Promise<string | null>
}

export interface CommandResult {
  output: string
  handled: boolean
}

const COMMANDS: Record<string, { desc: string; handler: (args: string, ctx: CommandContext) => CommandResult | Promise<CommandResult> }> = {
  '/help': {
    desc: 'Show available commands',
    handler: () => ({
      output: formatHelpText(),
      handled: true,
    }),
  },
  '/quit': {
    desc: 'Exit OwlCoda',
    handler: (_args, ctx) => {
      ctx.quit()
      return { output: '', handled: true }
    },
  },
  '/exit': {
    desc: 'Exit OwlCoda (alias)',
    handler: (_args, ctx) => {
      ctx.quit()
      return { output: '', handled: true }
    },
  },
  '/model': {
    desc: 'Show or switch model (/model [name])',
    handler: (args, ctx) => {
      if (!args.trim()) {
        return { output: formatModelList(ctx.config, ctx.currentModel), handled: true }
      }
      const target = args.trim()
      const resolved = resolveConfiguredModel(ctx.config, target)
      ctx.setModel(resolved.id)
      return {
        output: `Model switched to ${formatModelName(resolved.id)} (backend: ${dim(resolved.backendModel)})`,
        handled: true,
      }
    },
  },
  '/clear': {
    desc: 'Clear conversation history',
    handler: (_args, ctx) => {
      ctx.clearMessages()
      return { output: formatInfo('Conversation cleared.'), handled: true }
    },
  },
  '/status': {
    desc: 'Show current session status',
    handler: (_args, ctx) => {
      const lines: string[] = [
        bold('Session status:'),
        `  Model: ${formatModelName(ctx.currentModel)}`,
        `  Session: ${ctx.sessionId ?? 'none'}`,
        `  Messages: ${ctx.messageCount}`,
        `  Auto-approve: ${ctx.autoApprove ? 'on' : 'off'}`,
        `  Proxy: http://${ctx.config.host}:${ctx.config.port}`,
        `  Local runtime: ${ctx.config.routerUrl}`,
        `  Response style: ${ctx.config.responseModelStyle}`,
      ]
      return { output: lines.join('\n'), handled: true }
    },
  },
  '/approve': {
    desc: 'Toggle auto-approve for tool execution (/approve [on|off])',
    handler: (args, ctx) => {
      const arg = args.trim().toLowerCase()
      if (arg === 'on' || arg === 'yes' || arg === 'true') {
        ctx.setAutoApprove(true)
        return { output: formatInfo('Auto-approve: ON — tool calls will execute without confirmation.'), handled: true }
      } else if (arg === 'off' || arg === 'no' || arg === 'false') {
        ctx.setAutoApprove(false)
        return { output: formatInfo('Auto-approve: OFF — tool calls will require confirmation.'), handled: true }
      } else {
        // Toggle
        const newValue = !ctx.autoApprove
        ctx.setAutoApprove(newValue)
        return { output: formatInfo(`Auto-approve: ${newValue ? 'ON' : 'OFF'}`), handled: true }
      }
    },
  },
  '/resume': {
    desc: 'Resume a previous session (/resume [id|last])',
    handler: async (args, ctx) => {
      const target = args.trim() || 'last'
      const result = await ctx.resumeSession(target)
      if (result) {
        return { output: formatInfo(`Resumed session: ${result}`), handled: true }
      }
      return { output: formatError(`Session "${target}" not found.`), handled: true }
    },
  },
  '/session': {
    desc: 'Show current session info',
    handler: (_args, ctx) => {
      if (!ctx.sessionId) {
        return { output: 'No active session.', handled: true }
      }
      const lines: string[] = [
        bold('Current session:'),
        `  ID: ${ctx.sessionId}`,
        `  Model: ${formatModelName(ctx.currentModel)}`,
        `  Messages: ${ctx.messageCount}`,
      ]
      return { output: lines.join('\n'), handled: true }
    },
  },
  '/capabilities': {
    desc: 'Show supported/unsupported capabilities',
    handler: () => ({
      output: formatCapabilities(),
      handled: true,
    }),
  },
  '/doctor': {
    desc: 'Run diagnostics on OwlCoda platform health',
    handler: async (_args, ctx) => {
      const lines: string[] = [bold(`OwlCoda Doctor v${VERSION}`), '']
      const result = await runPreflight(ctx.config)

      // Router
      const r = result.router
      const rIcon = r.status === 'healthy_reused' ? '✅' : '❌'
      lines.push(`${rIcon} ${r.name}: ${r.detail} (${r.responseTimeMs ?? '?'}ms)`)

      // Backends
      for (const b of result.backends) {
        const bIcon = b.status === 'healthy_reused' ? '✅' : b.status === 'degraded' ? '⚠️' : '❌'
        lines.push(`${bIcon} ${b.name}: ${b.detail}`)
      }

      lines.push('')

      // MCP
      const hasMcp = CAPABILITIES.some(c => c.name.toLowerCase().includes('mcp') && c.status === 'supported')
      lines.push(hasMcp ? '✅ MCP servers: supported' : '⚠️  MCP servers: check .mcp.json')

      // Proxy
      lines.push(`✅ Proxy: port ${ctx.config.port ?? 8019}`)
      lines.push(`✅ Model: ${formatModelName(ctx.currentModel)}`)

      // Token usage
      const u = getTokenUsage()
      if (u.requestCount > 0) {
        const total = u.inputTokens + u.outputTokens
        lines.push(`📊 Tokens: ${formatTokenCount(total)} (${u.requestCount} requests)`)
      }

      // Trace status
      lines.push(`🔍 Trace: ${isTraceEnabled() ? 'ON' : 'OFF'}`)

      // Uptime
      const uptime = getUptime()
      lines.push(`⏱  Uptime: ${formatDuration(uptime)}`)

      // Recent errors
      const recentErrors = getRecentErrors(3)
      if (recentErrors.length > 0) {
        lines.push('')
        lines.push(bold('  Recent errors:'))
        for (const e of recentErrors) {
          const time = e.timestamp.slice(11, 19)
          lines.push(`  ❌ [${time}] ${e.endpoint}: ${e.message.slice(0, 80)}`)
          if (e.suggestion) lines.push(`     💡 ${e.suggestion}`)
        }
      } else if (getErrorCount() === 0) {
        lines.push('✅ No errors recorded')
      }

      lines.push('', dim(`Overall: ${result.canProceed ? 'Ready' : 'Degraded — ' + result.summary}`))
      return { output: lines.join('\n'), handled: true }
    },
  },
  '/config': {
    desc: 'Show current runtime configuration',
    handler: (_args, ctx) => {
      const models = listConfiguredModels(ctx.config)
      const defaultModel = getDefaultConfiguredModel(ctx.config)
      const featureFlags = ['MCP_RICH_OUTPUT', 'SLOW_OPERATION_LOGGING']
      const lines: string[] = [
        bold(`OwlCoda v${VERSION} — Runtime Config`),
        '',
        `  Active model:    ${formatModelName(ctx.currentModel)}`,
        `  Default model:   ${defaultModel ? formatModelName(defaultModel.id) : dim('none')}`,
        `  Configured models: ${models.length}`,
        `  Proxy:           http://${ctx.config.host}:${ctx.config.port}`,
        `  Local runtime:   ${ctx.config.routerUrl}`,
        `  Response style:  ${ctx.config.responseModelStyle}`,
        `  Log level:       ${ctx.config.logLevel}`,
        `  OWLCODA_HOME:      ${process.env.OWLCODA_HOME || '~/.owlcoda'}`,
        '',
        bold('  Feature flags:'),
        ...featureFlags.map(f => `    ✓ ${f}`),
        '',
        bold('  Session:'),
        `    ID:       ${ctx.sessionId ?? dim('none')}`,
        `    Messages: ${ctx.messageCount}`,
        `    Auto-approve: ${ctx.autoApprove ? 'on' : 'off'}`,
      ]
      return { output: lines.join('\n'), handled: true }
    },
  },
  '/trace': {
    desc: 'Toggle request/response trace logging (/trace [on|off])',
    handler: (args) => {
      const arg = args.trim().toLowerCase()
      if (arg === 'on' || arg === 'yes' || arg === '1') {
        setTraceEnabled(true)
      } else if (arg === 'off' || arg === 'no' || arg === '0') {
        setTraceEnabled(false)
      } else {
        setTraceEnabled(!isTraceEnabled())
      }
      const state = isTraceEnabled() ? 'ON' : 'OFF'
      const detail = isTraceEnabled() ? ' (trace files → ~/.owlcoda/trace/)' : ''
      return { output: formatInfo(`Trace: ${state}${detail}`), handled: true }
    },
  },
  '/tokens': {
    desc: 'Show token usage for current session',
    handler: () => {
      const u = getTokenUsage()
      const total = u.inputTokens + u.outputTokens
      const elapsed = Math.round((Date.now() - new Date(u.startedAt).getTime()) / 1000)
      const lines: string[] = [
        bold('Token Usage:'),
        `  Input:    ${formatTokenCount(u.inputTokens)}`,
        `  Output:   ${formatTokenCount(u.outputTokens)}`,
        `  Total:    ${formatTokenCount(total)}`,
        `  Requests: ${u.requestCount}`,
        `  Elapsed:  ${formatDuration(elapsed)}`,
      ]
      if (u.cacheReadTokens > 0 || u.cacheWriteTokens > 0) {
        lines.push(`  Cache read:  ${formatTokenCount(u.cacheReadTokens)}`)
        lines.push(`  Cache write: ${formatTokenCount(u.cacheWriteTokens)}`)
      }
      return { output: lines.join('\n'), handled: true }
    },
  },
  '/budget': {
    desc: 'Show context window budget for current model',
    handler: (_args, ctx) => {
      const contextWindow = resolveModelContextWindow(ctx.config, ctx.currentModel)
      const u = getTokenUsage()
      const total = u.inputTokens + u.outputTokens

      if (contextWindow <= 0) {
        return {
          output: formatInfo(`Used: ${formatTokenCount(total)} | Context window: unknown (model not in catalog)`),
          handled: true,
        }
      }

      const pct = ((total / contextWindow) * 100).toFixed(1)
      const remaining = contextWindow - total
      const lines: string[] = [
        bold('Context Budget:'),
        `  Used:      ${formatTokenCount(total)} / ${formatTokenCount(contextWindow)} (${pct}%)`,
        `  Remaining: ~${formatTokenCount(Math.max(0, remaining))}`,
        `  Model:     ${formatModelName(ctx.currentModel)}`,
      ]
      if (Number(pct) > 80) {
        lines.push(dim('  ⚠  Approaching context limit — consider /clear'))
      }
      return { output: lines.join('\n'), handled: true }
    },
  },
  '/plugins': {
    desc: 'List loaded plugins or reload (/plugins reload)',
    handler: async (args) => {
      if (args.trim() === 'reload') {
        const plugins = await loadPlugins()
        return { output: formatInfo(`Reloaded: ${plugins.length} plugin(s) found`), handled: true }
      }
      const plugins = getLoadedPlugins()
      if (plugins.length === 0) {
        return { output: dim('No plugins loaded. Place plugins in ~/.owlcoda/plugins/<name>/index.js'), handled: true }
      }
      const lines: string[] = [bold('Loaded Plugins:'), '']
      for (const p of plugins) {
        const meta = p.plugin.metadata
        lines.push(`  📦 ${meta.name} v${meta.version} (${p.hookCount} hooks)`)
        if (meta.description) lines.push(`     ${dim(meta.description)}`)
      }
      return { output: lines.join('\n'), handled: true }
    },
  },
  '/export': {
    desc: 'Export conversation (/export [markdown])',
    handler: async (args, ctx) => {
      if (!ctx.sessionId) {
        return { output: formatError('No active session to export.'), handled: true }
      }
      const format = args.trim().toLowerCase() === 'markdown' ? 'markdown' : 'json'
      const { exportSession } = await import('../session-export.js')
      const filePath = await exportSession(ctx.sessionId, ctx.currentModel, ctx.messageCount, format)
      return { output: formatInfo(`Exported to: ${filePath}`), handled: true }
    },
  },
  '/sessions': {
    desc: 'Browse sessions (/sessions [search <query>|delete <id>|info <id>])',
    handler: async (args) => {
      const parts = args.trim().split(/\s+/)
      const sub = parts[0]?.toLowerCase()

      if (sub === 'search' && parts.length > 1) {
        const query = parts.slice(1).join(' ')
        const results = await searchSessions(query)
        if (results.length === 0) return { output: dim(`No sessions matching "${query}"`), handled: true }
        const lines: string[] = [bold(`Search: "${query}" — ${results.length} result(s)`), '']
        for (const r of results) {
          lines.push(`  ${r.meta.id}  ${r.meta.model}  ${r.meta.messageCount} msgs`)
          lines.push(`    ${dim(r.matchedPreview)}`)
        }
        return { output: lines.join('\n'), handled: true }
      }

      if (sub === 'delete' && parts[1]) {
        const ok = await deleteSession(parts[1])
        return { output: ok ? formatInfo(`Deleted session ${parts[1]}`) : formatError(`Session ${parts[1]} not found`), handled: true }
      }

      if (sub === 'info' && parts[1]) {
        const session = await loadSession(parts[1])
        if (!session) return { output: formatError(`Session ${parts[1]} not found`), handled: true }
        const m = session.meta
        const lines = [
          bold(`Session: ${m.id}`),
          `  Model:    ${m.model}`,
          `  Created:  ${m.createdAt}`,
          `  Updated:  ${m.updatedAt}`,
          `  Messages: ${m.messageCount}`,
          `  Preview:  ${m.preview || dim('(none)')}`,
          `  CWD:      ${m.cwd}`,
          `  Tags:     ${m.tags?.length ? m.tags.join(', ') : dim('(none)')}`,
        ]
        return { output: lines.join('\n'), handled: true }
      }

      // Default: list recent sessions
      const sessions = await listSessions(10)
      if (sessions.length === 0) return { output: dim('No sessions found.'), handled: true }
      const lines: string[] = [bold(`Recent Sessions (${sessions.length}):`), '']
      for (const s of sessions) {
        const tags = s.tags?.length ? ` [${s.tags.join(',')}]` : ''
        lines.push(`  ${s.id}  ${s.model}  ${s.messageCount} msgs${tags}`)
        if (s.preview) lines.push(`    ${dim(s.preview.slice(0, 60))}`)
      }
      return { output: lines.join('\n'), handled: true }
    },
  },
  '/tag': {
    desc: 'Tag sessions (/tag add|remove|list|search <value>)',
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/)
      const sub = parts[0]?.toLowerCase()
      const value = parts.slice(1).join(' ')

      if (sub === 'add' && value && ctx.sessionId) {
        const ok = await addSessionTag(ctx.sessionId, value)
        return { output: ok ? formatInfo(`Tagged "${value}"`) : dim(`Tag "${value}" already exists`), handled: true }
      }
      if (sub === 'remove' && value && ctx.sessionId) {
        const ok = await removeSessionTag(ctx.sessionId, value)
        return { output: ok ? formatInfo(`Removed tag "${value}"`) : dim(`Tag "${value}" not found`), handled: true }
      }
      if (sub === 'list') {
        if (!ctx.sessionId) return { output: formatError('No active session'), handled: true }
        const session = await loadSession(ctx.sessionId)
        const tags = session?.meta.tags ?? []
        return { output: tags.length ? formatInfo(`Tags: ${tags.join(', ')}`) : dim('No tags'), handled: true }
      }
      if (sub === 'search' && value) {
        const results = await findSessionsByTag(value)
        if (results.length === 0) return { output: dim(`No sessions tagged "${value}"`), handled: true }
        const lines: string[] = [bold(`Sessions tagged "${value}" (${results.length}):`), '']
        for (const s of results) {
          lines.push(`  ${s.id}  ${s.model}  ${s.messageCount} msgs`)
        }
        return { output: lines.join('\n'), handled: true }
      }

      return { output: dim('Usage: /tag add|remove|list|search <value>'), handled: true }
    },
  },
  '/compress': {
    desc: 'Compress session (/compress [--trim N] [session-id])',
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/)
      let trimMode = false
      let keepLast = 10
      let targetId = ctx.sessionId

      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === '--trim') {
          trimMode = true
          const n = parseInt(parts[i + 1] ?? '', 10)
          if (!isNaN(n) && n > 0) { keepLast = n; i++ }
        } else if (parts[i] && parts[i] !== '--trim') {
          targetId = parts[i]
        }
      }

      if (!targetId) return { output: formatError('No session specified. Use /compress [session-id] or be in an active session.'), handled: true }

      try {
        if (trimMode) {
          const { trimSession } = await import('../session-compress.js')
          const result = await trimSession(targetId, keepLast)
          return {
            output: formatInfo(`Compressed: ${result.originalMessages} → ${result.compressedMessages} messages (trim, kept last ${keepLast})\nBackup: ${result.backupPath}`),
            handled: true,
          }
        }

        // LLM compression
        const proxyUrl = `http://127.0.0.1:${ctx.config.port}`
        const { compressSessionWithLLM } = await import('../session-compress.js')
        const result = await compressSessionWithLLM(targetId, proxyUrl, ctx.currentModel, keepLast)
        return {
          output: formatInfo(`Compressed: ${result.originalMessages} → ${result.compressedMessages} messages (LLM summary + last ${keepLast})\nBackup: ${result.backupPath}`),
          handled: true,
        }
      } catch (err) {
        return { output: formatError(`Compression failed: ${err instanceof Error ? err.message : String(err)}`), handled: true }
      }
    },
  },
  '/history': {
    desc: 'View message history (/history [N] [session-id])',
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      let limit = 20
      let targetId = ctx.sessionId

      for (const p of parts) {
        const n = parseInt(p, 10)
        if (!isNaN(n) && n > 0) { limit = n }
        else { targetId = p }
      }

      if (!targetId) return { output: formatError('No active session. Use /history <session-id>'), handled: true }

      const session = await loadSession(targetId)
      if (!session) return { output: formatError(`Session ${targetId} not found`), handled: true }

      const msgs = session.messages.slice(-limit)
      if (msgs.length === 0) return { output: dim('No messages in session.'), handled: true }

      const lines: string[] = [bold(`History: ${targetId} (last ${msgs.length} of ${session.messages.length})`), '']
      for (const m of msgs) {
        const role = m.role === 'user' ? '👤' : '🤖'
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        const preview = text.slice(0, 120).replace(/\n/g, ' ')
        const time = m.timestamp ? dim(` ${m.timestamp.slice(11, 19)}`) : ''
        lines.push(`  ${role} ${preview}${time}`)
      }
      return { output: lines.join('\n'), handled: true }
    },
  },
  '/branch': {
    desc: 'Branch current session (/branch [name])',
    handler: async (args, ctx) => {
      if (!ctx.sessionId) return { output: formatError('No active session to branch.'), handled: true }
      const name = args.trim() || undefined
      const newId = await branchSession(ctx.sessionId, name)
      return { output: formatInfo(`Branched → ${newId}${name ? ` (${name})` : ''}\nUse /resume ${newId} to switch to it.`), handled: true }
    },
  },
  '/branches': {
    desc: 'List branches of current session',
    handler: async (_args, ctx) => {
      if (!ctx.sessionId) return { output: formatError('No active session.'), handled: true }
      const branches = await listBranches(ctx.sessionId)
      if (branches.length === 0) return { output: dim('No branches found.'), handled: true }
      const lines: string[] = [bold(`Branches of ${ctx.sessionId} (${branches.length}):`), '']
      for (const b of branches) {
        const name = b.branchName ? ` [${b.branchName}]` : ''
        lines.push(`  ${b.id}${name}  ${b.messageCount} msgs  ${dim(b.updatedAt.slice(0, 10))}`)
      }
      return { output: lines.join('\n'), handled: true }
    },
  },
  '/cost': {
    desc: 'Show token usage and estimated cost for this session',
    handler: (_args, ctx) => {
      const usage = getTokenUsage()
      if (usage.requestCount === 0) {
        return { output: dim('No usage recorded yet.'), handled: true }
      }

      const lines = [
        bold('Token Usage:'),
        `  Input tokens:  ${usage.inputTokens.toLocaleString()}`,
        `  Output tokens: ${usage.outputTokens.toLocaleString()}`,
        `  Total tokens:  ${(usage.inputTokens + usage.outputTokens).toLocaleString()}`,
        `  Requests:      ${usage.requestCount}`,
        `  Since:         ${usage.startedAt}`,
      ]

      // Multi-model session cost using real perf data
      const allMetrics = getAllModelMetrics()
      if (allMetrics.length > 0) {
        const modelUsage = allMetrics.map(m => {
          const perf = getModelPerfSummary(m.modelId)
          return {
            modelId: m.modelId,
            inputTokens: m.totalInputTokens,
            outputTokens: m.totalOutputTokens,
            realTps: perf?.avgOutputTps,
          }
        })
        const summary = getSessionCostSummary(modelUsage)

        lines.push('', bold('Cost by Model:'))
        for (const entry of summary.perModel) {
          const c = entry.cost
          const perf = getModelPerfSummary(entry.modelId)
          const tpsInfo = perf ? dim(` @ ${perf.avgOutputTps} tok/s`) : ''
          lines.push(
            `  ${bold(entry.modelId)}${tpsInfo}`,
            `    ${c.totalCost.toFixed(4)} ${c.unit}` +
              dim(` (in: ${c.inputCost.toFixed(4)} / out: ${c.outputCost.toFixed(4)}, ${c.source})`),
          )
        }
        lines.push(
          '',
          bold(`Session Total: ${summary.totalCost.toFixed(4)} ${summary.unit}`),
        )
      } else {
        // Fallback: single-model estimate from config
        const defaultModel = getDefaultConfiguredModel(ctx.config)
        const modelId = defaultModel?.backendModel ?? 'unknown'
        const cost = estimateCost(usage.inputTokens, usage.outputTokens, modelId)
        const breakdown = formatCostBreakdown(usage.inputTokens, usage.outputTokens, cost)
        lines.push(
          '',
          bold('Cost Estimate:') + dim(`  (model: ${modelId})`),
          ...breakdown.split('\n').map(l => `  ${l}`),
        )
      }

      return { output: lines.join('\n'), handled: true }
    },
  },
  '/dashboard': {
    desc: 'Show observability metrics',
    handler: (_args, _ctx) => {
      const m = getMetrics()
      const lines = [
        bold('OwlCoda Dashboard:'),
        `  Version:         ${m.version}`,
        `  Uptime:          ${m.uptime}s`,
        `  Total requests:  ${m.totalRequests}`,
        `  Active requests: ${m.activeRequests}`,
        '',
      ]
      const modelKeys = Object.keys(m.requestsByModel)
      if (modelKeys.length > 0) {
        lines.push(bold('  Requests by endpoint:'))
        for (const [k, v] of Object.entries(m.requestsByModel)) {
          const avg = m.avgDurationByModel[k] ?? '-'
          lines.push(`    ${k}: ${v} reqs (avg ${avg}ms)`)
        }
        lines.push('')
      }
      lines.push(bold('  Tokens:'))
      lines.push(`    Input:  ${m.tokenUsage.inputTokens.toLocaleString()}`)
      lines.push(`    Output: ${m.tokenUsage.outputTokens.toLocaleString()}`)
      lines.push(`    Total:  ${m.tokenUsage.totalTokens.toLocaleString()}`)
      lines.push('')
      lines.push(`  Recent errors: ${m.recentErrors}`)

      // Error budget summary
      const budgets = getAllBudgets()
      if (budgets.size > 0) {
        lines.push('')
        lines.push(bold('  Error Budgets:'))
        const slo = getSloTarget()
        for (const [model, b] of budgets) {
          const status = b.budgetRemaining >= 0 ? '✓' : '✗'
          lines.push(`    ${status} ${model}: ${(b.successRate * 100).toFixed(1)}% (${b.total} reqs, SLO ${(slo * 100).toFixed(0)}%)`)
        }
      }

      // Recent traces summary
      const traces = getRecentTraces(3)
      if (traces.length > 0) {
        lines.push('')
        lines.push(bold('  Recent Traces:'))
        for (const t of traces) {
          lines.push(`    ${t.requestId.slice(0, 8)} — ${t.totalMs}ms`)
        }
      }

      return { output: lines.join('\n'), handled: true }
    },
  },
  '/ratelimit': {
    desc: 'Show per-model rate limit status',
    handler: (_args, _ctx) => {
      const stats = getRateLimitStats()
      const models = Object.keys(stats)
      if (models.length === 0) {
        return { output: dim('No rate limit data — no requests made yet.'), handled: true }
      }
      const lines = [bold('Rate Limits:')]
      for (const [model, s] of Object.entries(stats)) {
        lines.push(`  ${model}: ${s.remaining}/${s.total} remaining (resets ${new Date(s.resetAtMs).toLocaleTimeString()})`)
      }
      return { output: lines.join('\n'), handled: true }
    },
  },
  '/audit': {
    desc: 'Show recent request audit log (/audit [count])',
    handler: async (args, _ctx) => {
      const count = parseInt(args) || 10
      const entries = await readAuditLog(count)
      if (entries.length === 0) {
        return { output: dim('No audit entries yet.'), handled: true }
      }
      const lines = [bold(`Audit Log (last ${entries.length}):`), '']
      for (const e of entries) {
        const fb = e.fallbackUsed ? ' [fallback]' : ''
        const stream = e.streaming ? ' [stream]' : ''
        lines.push(`  ${e.timestamp.slice(11, 19)} ${e.model}→${e.servedBy ?? e.model} ${e.status} ${e.inputTokens}/${e.outputTokens}tok${fb}${stream}`)
      }
      return { output: lines.join('\n'), handled: true }
    },
  },
  '/health': {
    desc: 'Show model health and circuit breaker status',
    handler: (_args, ctx) => {
      const health = getAllModelHealth()
      const circuits = getAllCircuitStates()
      const models = ctx.config.models

      if (models.length === 0) {
        return { output: dim('No models configured.'), handled: true }
      }

      const lines = [bold('Model Health:'), '']
      for (const m of models) {
        const h = health[m.id]
        const c = circuits[m.id]
        const hIcon = !h ? '?' : h.status === 'healthy' ? '✅' : h.status === 'unhealthy' ? '❌' : '❓'
        const cState = c ? ` circuit:${c.state}(${c.failures}f)` : ''
        const latency = h?.latencyMs ? ` ${h.latencyMs}ms` : ''
        lines.push(`  ${hIcon} ${m.id}${latency}${cState}`)
      }
      return { output: lines.join('\n'), handled: true }
    },
  },
  '/slo': {
    desc: 'Show per-model error budget and SLO status',
    handler: (_args, _ctx) => {
      const budgets = getAllBudgets()
      const slo = getSloTarget()

      if (budgets.size === 0) {
        return { output: dim('No request data yet. Error budgets populate after first request.'), handled: true }
      }

      const lines = [bold('Error Budget:'), `  SLO target: ${(slo * 100).toFixed(0)}%`, '']
      lines.push(`  ${'Model'.padEnd(35)} ${'Reqs'.padStart(5)} ${'OK%'.padStart(6)} ${'Budget'.padStart(8)} Status`)
      lines.push(`  ${'─'.repeat(65)}`)
      for (const [model, b] of budgets) {
        const rate = (b.successRate * 100).toFixed(1)
        const budget = (b.budgetRemaining * 100).toFixed(1)
        const status = b.budgetRemaining >= 0 ? '✓ OK' : '✗ VIOLATED'
        lines.push(`  ${model.padEnd(35)} ${String(b.total).padStart(5)} ${rate.padStart(5)}% ${(budget + '%').padStart(8)} ${status}`)
      }
      return { output: lines.join('\n'), handled: true }
    },
  },
  '/traces': {
    desc: 'Show recent request traces with timing waterfall',
    handler: (args, _ctx) => {
      const count = parseInt(args) || 5
      const traces = getRecentTraces(count)

      if (traces.length === 0) {
        return { output: dim('No request traces yet.'), handled: true }
      }

      const lines = [bold('Recent Traces:'), '']
      for (const t of traces) {
        lines.push(`  ${t.requestId.slice(0, 8)} — ${t.totalMs}ms total`)
        for (const p of t.phases) {
          lines.push(`    ${p.name.padEnd(15)} +${p.durationMs}ms`)
        }
        lines.push('')
      }
      return { output: lines.join('\n'), handled: true }
    },
  },

  '/reset-circuits': {
    desc: 'Reset all circuit breakers to closed state',
    handler: () => {
      resetCircuitBreaker()
      return { output: formatInfo('All circuit breakers reset to closed state.'), handled: true }
    },
  },

  '/reset-budgets': {
    desc: 'Reset all error budget windows',
    handler: () => {
      resetBudgets()
      return { output: formatInfo('All error budget windows reset.'), handled: true }
    },
  },

  '/metrics': {
    desc: 'Show Prometheus-format metrics',
    handler: () => {
      return { output: renderMetrics(), handled: true }
    },
  },

  '/backends': {
    desc: 'Discover local LLM backends (Ollama, LM Studio, vLLM)',
    handler: async (_args, ctx) => {
      const configs = ctx.config.backends ?? [
        { type: 'ollama' as const, enabled: true },
        { type: 'lmstudio' as const, enabled: true },
        { type: 'vllm' as const, enabled: true },
      ]
      const result = await discoverBackends(configs, 5000)
      return { output: formatDiscoveryResult(result), handled: true }
    },
  },
  '/warmup': {
    desc: 'Warm up discovered backend models (pre-load weights)',
    handler: async (_args, ctx) => {
      const modelsWithEndpoint = ctx.config.models.filter(m => m.endpoint)
      if (modelsWithEndpoint.length === 0) {
        return { output: dim('No models with direct endpoints to warm up.'), handled: true }
      }
      const results = await warmupModels(ctx.config, { concurrency: 2, timeoutMs: 15_000 })
      return { output: formatWarmupResults(results), handled: true }
    },
  },
  '/perf': {
    desc: 'Show per-model performance metrics (latency, TPS, success rate)',
    handler: (_args, _ctx) => {
      return { output: formatAllPerfSummaries(), handled: true }
    },
  },
  '/recommend': {
    desc: 'Recommend best model for an intent (code|analysis|chat|search|general)',
    handler: (args, ctx) => {
      const validIntents: Intent[] = ['code', 'analysis', 'search', 'chat', 'general']
      const intent = (args[0] ?? 'general') as Intent
      if (!validIntents.includes(intent)) {
        return { output: formatError(`Invalid intent "${intent}". Use: ${validIntents.join(', ')}`), handled: true }
      }
      const rec = recommendModel(ctx.config, intent)
      return { output: formatRecommendation(rec), handled: true }
    },
  },
}

export function isCommand(input: string): boolean {
  return input.startsWith('/')
}

export async function handleCommand(input: string, ctx: CommandContext): Promise<CommandResult> {
  const spaceIdx = input.indexOf(' ')
  const cmd = spaceIdx === -1 ? input : input.slice(0, spaceIdx)
  const args = spaceIdx === -1 ? '' : input.slice(spaceIdx + 1)

  const handler = COMMANDS[cmd]
  if (handler) {
    return handler.handler(args, ctx)
  }

  return {
    output: `Unknown command: ${cmd}. Type /help for available commands.`,
    handled: true,
  }
}

function formatHelpText(): string {
  const lines: string[] = [bold(`OwlCoda v${VERSION} — Commands:`), '']
  for (const [cmd, { desc }] of Object.entries(COMMANDS)) {
    if (cmd === '/exit') continue // Don't show alias
    lines.push(`  ${cmd.padEnd(18)} ${dim(desc)}`)
  }
  lines.push('')
  lines.push(dim('  Any other input is sent as a message to the model.'))
  return lines.join('\n')
}

function formatModelList(config: OwlCodaConfig, currentModel: string): string {
  const models = listConfiguredModels(config)
  if (models.length === 0) {
    return 'No models configured. Ensure platform catalog is accessible or add models to config.'
  }
  const lines: string[] = [bold('Available models:'), '']
  for (const m of models) {
    const isCurrent = m.id === currentModel
    const marker = isCurrent ? ' ← current' : ''
    const defaultMarker = m.default ? ' (default)' : ''
    const channelTag = m.channel ? ` [${m.channel}]` : ''
    const availTag = m.availability === 'available' ? ' ✓'
      : m.availability === 'unavailable' ? ' ✗ unavailable'
      : ''
    lines.push(`  ${formatModelName(m.id)}${defaultMarker}${channelTag}${availTag}${marker}`)
    lines.push(dim(`    ${m.label} — ${m.role ?? m.tier}`))
    if (m.aliases.length > 0) {
      lines.push(dim(`    Aliases: ${m.aliases.join(', ')}`))
    }
  }
  if (config.catalogLoaded) {
    lines.push('')
    lines.push(dim('  (catalog-driven — models from platform catalog)'))
  }
  lines.push('')
  lines.push(dim('  Switch with /model <name> using a model ID or alias.'))
  const examples = buildModelSwitchExamples(models)
  if (examples.length > 0) {
    lines.push(dim(`  Examples: ${examples.join('   ')}`))
  }
  return lines.join('\n')
}

function buildModelSwitchExamples(models: ConfiguredModel[]): string[] {
  const examples: string[] = []
  for (const model of models) {
    const target = model.aliases[0] ?? model.id
    if (!target || examples.includes(target)) continue
    examples.push(`/model ${target}`)
    if (examples.length >= 3) break
  }
  return examples
}

function formatCapabilities(): string {
  const statusIcon = (s: CapabilityStatus): string => {
    switch (s) {
      case 'supported': return '✅'
      case 'partial': case 'best_effort': return '⚠️ '
      case 'manual-only': return '🔧'
      case 'blocked': return '🚫'
      case 'unsupported': return '❌'
    }
  }
  const statusLabel = (s: CapabilityStatus): string => {
    switch (s) {
      case 'supported': return 'Supported'
      case 'partial': return 'Partial'
      case 'best_effort': return 'Best-effort'
      case 'manual-only': return 'Manual-only'
      case 'blocked': return 'Blocked'
      case 'unsupported': return 'Unsupported (cloud-only)'
    }
  }

  const groups = new Map<string, typeof CAPABILITIES>()
  for (const cap of CAPABILITIES) {
    const key = statusLabel(cap.status)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(cap)
  }

  const lines: string[] = [bold('OwlCoda Capabilities:'), '']
  for (const [label, caps] of groups) {
    const icon = statusIcon(caps[0]!.status)
    lines.push(`  ${icon} ${label}:`)
    for (const cap of caps) {
      lines.push(`    • ${cap.name} — ${dim(cap.detail)}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

function formatDiscoveryResult(result: DiscoveryResult): string {
  const lines: string[] = [bold('Backend Discovery'), '']

  if (result.models.length === 0) {
    lines.push('  No local backends detected.')
    lines.push(dim('  Start Ollama (port 11434), LM Studio (1234), or vLLM (8000) to use direct backends.'))
    lines.push('')
    lines.push(dim(`  Probed in ${result.durationMs}ms`))
    return lines.join('\n')
  }

  // Group by backend
  const byBackend = new Map<string, typeof result.models>()
  for (const m of result.models) {
    if (!byBackend.has(m.backend)) byBackend.set(m.backend, [])
    byBackend.get(m.backend)!.push(m)
  }

  for (const [backend, models] of byBackend) {
    const first = models[0]!
    lines.push(`  ${bold(backend)} — ${first.baseUrl} (${models.length} model${models.length > 1 ? 's' : ''})`)
    for (const m of models) {
      const parts = [`    ${m.label}`]
      if (m.parameterSize) parts.push(dim(m.parameterSize))
      if (m.quantization) parts.push(dim(m.quantization))
      if (m.contextWindow) parts.push(dim(`${Math.round(m.contextWindow / 1024)}K ctx`))
      lines.push(parts.join(' '))
    }
    lines.push('')
  }

  if (result.unreachableBackends.length > 0) {
    lines.push(dim(`  Unreachable: ${result.unreachableBackends.join(', ')}`))
  }
  lines.push(dim(`  ${result.models.length} model${result.models.length > 1 ? 's' : ''} discovered in ${result.durationMs}ms`))
  return lines.join('\n')
}
