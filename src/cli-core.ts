/**
 * CLI core logic — command implementations and arg parsing.
 * Daemon lifecycle and healthz client are in separate modules.
 * This module has NO side effects on import. Tests import this, not cli.ts.
 */

import { existsSync } from 'node:fs'
import { loadConfig, getPreferredInteractiveConfiguredModel, type OwlCodaConfig } from './config.js'
import { startServer } from './server.js'
import { runPreflight, formatPreflightForCli } from './preflight.js'
import { VERSION } from './version.js'
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
} from './admin-delivery.js'

// Re-export from extracted modules for backward compatibility
export { VERSION }
export { resolveClientHost, healthzMatchesConfig, healthzMatchesRuntimeMeta } from './healthz-client.js'
export type { HealthzResponse } from './healthz-client.js'
export { buildDaemonArgs, getBaseUrl } from './daemon.js'
export type { RuntimeMeta } from './daemon.js'

// Import for internal use
import {
  type RuntimeMeta,
  ensureProxyRunning,
  readPid,
  removePid,
  readRuntimeMeta,
  removeRuntimeMeta,
  isPidAlive,
  verifyManagedDaemon,
  getMetaBaseUrl,
  stopAndWait,
  getBaseUrl,
} from './daemon.js'
import {
  createLiveReplClientId,
  detachLiveReplClient,
  detachLiveReplClientsForRuntime,
  enrichLiveReplClientForAdmin,
  formatLiveReplClientAdminSummary,
  formatLiveReplClientAge,
  formatLiveReplClientDetail,
  formatLiveReplLeaseTarget,
  formatLiveReplClientSummary,
  getActiveLiveReplClientsForRuntime,
  listActiveLiveReplClients,
  LIVE_REPL_CLIENT_ADMIN_SCHEMA_VERSION,
  removeLiveReplClientIfOwned,
  resolveLiveReplResumeTarget,
  type LiveReplClientLease,
  upsertLiveReplClient,
} from './repl-lease.js'

function isOwlcodaRunDebugEnabled(): boolean {
  const value = process.env['OWLCODA_DEBUG_RUN']
  return value === '1' || value === 'true'
}

function isLaunchStartupVerbose(): boolean {
  const value = (process.env['OWLCODA_STARTUP_VERBOSE'] ?? '').trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

function getTopTags(skills: Array<{ tags: string[] }>): [string, number][] {
  const counts = new Map<string, number>()
  for (const s of skills) {
    for (const t of s.tags) {
      counts.set(t, (counts.get(t) ?? 0) + 1)
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

export function loadEffectiveConfig(configPath?: string, port?: number, routerUrl?: string): OwlCodaConfig {
  const config = loadConfig(configPath)
  if (port !== undefined) config.port = port
  if (routerUrl !== undefined) config.routerUrl = routerUrl
  return config
}

function getActiveLiveClientsForRuntime(meta: RuntimeMeta): LiveReplClientLease[] {
  return getActiveLiveReplClientsForRuntime({
    host: meta.host,
    port: meta.port,
    routerUrl: meta.routerUrl,
    runtimeToken: meta.runtimeToken,
  })
}

function printActiveLiveClientDetails(clients: LiveReplClientLease[]): void {
  for (const client of clients) {
    console.error(`  - ${formatLiveReplClientSummary(client)}`)
  }
}

function resolveResumeSessionTarget(
  requestedTarget: string | undefined,
  runtime: RuntimeMeta,
  mode: 'launch' | 'run',
  currentClientId?: string,
): string | undefined {
  const resolution = resolveLiveReplResumeTarget(requestedTarget, {
    currentClientId,
    runtime: {
      host: runtime.host,
      port: runtime.port,
      routerUrl: runtime.routerUrl,
      runtimeToken: runtime.runtimeToken,
    },
  })

  if (!requestedTarget) return undefined

  if (resolution.reason === 'owned_by_live_client' && resolution.blockedBy) {
    console.error(
      `Cannot ${mode} with session ${resolution.requestedTarget}: ${resolution.blockedBy.sessionId ?? resolution.requestedTarget} is currently owned by live REPL client PID ${resolution.blockedBy.clientPid} at ${formatLiveReplLeaseTarget(resolution.blockedBy)}`,
    )
    process.exit(1)
  }

  if (requestedTarget === 'last') {
    if (resolution.reason === 'ok' && resolution.resolvedTarget) {
      if (resolution.skippedLiveSessionIds.length > 0) {
        console.error(
          `Resume last: skipped ${resolution.skippedLiveSessionIds.length} live-owned session${resolution.skippedLiveSessionIds.length === 1 ? '' : 's'} and selected ${resolution.resolvedTarget}`,
        )
      }
      return resolution.resolvedTarget
    }
    if (resolution.reason === 'no_resumable_session') {
      console.error('Resume last: all recent sessions are actively owned by live REPL clients; starting a fresh session instead.')
      return undefined
    }
    return undefined
  }

  if (resolution.reason === 'ok' && resolution.resolvedTarget) {
    return resolution.resolvedTarget
  }

  return requestedTarget
}

// ─── Arg parsing ───

export function parseArgs(argv: string[]): {
  command: string
  port?: number
  configPath?: string
  routerUrl?: string
  model?: string
  daemonOnly?: boolean
  prompt?: string
  jsonOutput?: boolean
  autoApprove?: boolean
  resumeSession?: string
  force?: boolean
  dryRun?: boolean
  printUrl?: boolean
  openBrowser?: boolean
  route?: 'models' | 'aliases' | 'orphans' | 'catalog'
  select?: string
  view?: string
  passthroughArgs: string[]
} {
  const args = argv.slice(2)
  let command = 'launch'
  let commandExplicit = false
  let port: number | undefined
  let configPath: string | undefined
  let routerUrl: string | undefined
  let model: string | undefined
  let daemonOnly = false
  let prompt: string | undefined
  let jsonOutput = false
  let autoApprove = false
  let resumeSession: string | undefined
  let force = false
  let dryRun = false
  let printUrl = false
  let openBrowser = false
  let route: 'models' | 'aliases' | 'orphans' | 'catalog' | undefined
  let select: string | undefined
  let view: string | undefined
  const passthroughArgs: string[] = []
  let pastSeparator = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!

    if (arg === '--') {
      pastSeparator = true
      continue
    }
    if (pastSeparator) {
      passthroughArgs.push(arg)
      continue
    }

    // Once a command is explicitly set, non-flag args become subcommand args
    // (e.g. "training status" → command=training, passthroughArgs=["status"])
    if (commandExplicit && !arg.startsWith('-')) {
      passthroughArgs.push(arg)
      continue
    }

    const prevCommand = command
    switch (arg) {
      case '--help':
      case '-h':
        command = 'help'
        break
      case '--version':
      case '-v':
        command = 'version'
        break
      case '--port':
        port = parseInt(args[++i] ?? '', 10)
        break
      case '--config':
      case '-c':
        configPath = args[++i]
        break
      case '--router':
      case '-r':
        routerUrl = args[++i]
        break
      case '--model':
      case '-m':
        model = args[++i]
        break
      case '--daemon-only':
        daemonOnly = true
        break
      case '--native':
        break
      case '-p':
      case '--prompt':
        prompt = args[++i]
        break
      case '--json':
        jsonOutput = true
        break
      case '--auto-approve':
        autoApprove = true
        break
      case '--resume':
        resumeSession = args[++i] ?? 'last'
        break
      case '--force':
        force = true
        break
      case '--dry-run':
        dryRun = true
        break
      case '--print-url':
        printUrl = true
        break
      case '--open-browser':
        openBrowser = true
        break
      case '--route': {
        const value = args[++i] as typeof route
        if (value === 'models' || value === 'aliases' || value === 'orphans' || value === 'catalog') {
          route = value
        }
        break
      }
      case '--select':
        select = args[++i]
        break
      case '--view':
        view = args[++i]
        break
      case 'server':
        command = 'server'
        break
      case 'start':
        command = 'start'
        break
      case 'stop':
        command = 'stop'
        break
      case 'status':
        command = 'status'
        break
      case 'run':
        command = 'run'
        break
      case 'serve':
        command = 'serve'
        break
      case 'clients':
        command = 'clients'
        break
      case 'doctor':
        command = 'doctor'
        break
      case 'sessions':
        command = 'sessions'
        break
      case 'init':
        command = 'init'
        break
      case 'config':
        command = 'config'
        break
      case 'logs':
        command = 'logs'
        break
      case 'completions':
        command = 'completions'
        break
      case 'models':
        command = 'models'
        break
      case 'benchmark':
        command = 'benchmark'
        break
      case 'export':
        command = 'export'
        break
      case 'inspect':
        command = 'inspect'
        break
      case 'validate':
        command = 'validate'
        break
      case 'health':
        command = 'health'
        break
      case 'audit':
        command = 'audit'
        break
      case 'cache':
        command = 'cache'
        break
      case 'skills':
        command = 'skills'
        break
      case 'ui':
      case 'admin':
        command = 'ui'
        break
      case 'training':
        command = 'training'
        break
      default:
        passthroughArgs.push(arg)
    }
    if (command !== prevCommand) commandExplicit = true
  }

  return {
    command,
    port,
    configPath,
    routerUrl,
    model,
    daemonOnly,
    prompt,
    jsonOutput,
    autoApprove,
    resumeSession,
    force,
    dryRun,
    printUrl,
    openBrowser,
    route,
    select,
    view,
    passthroughArgs,
  }
}


// ─── Commands ───

export function printHelp(): void {
  console.error(`owlcoda v${VERSION} — Local AI coding platform
  Native mode: 42+ tools · 69+ commands · local model routing · skills · sessions

Usage:
  owlcoda                       Open the native REPL (proxy auto-started)
  owlcoda -p "…"                Headless one-shot (alias of \`owlcoda run -p\`)
  owlcoda init                  Create config.json (auto-detects local backend)
  owlcoda doctor                Diagnose environment

Daily:
  owlcoda                       Native REPL (default)
  owlcoda run -p "…"            Single-shot: send prompt, print response, exit
  owlcoda --resume [id|last]    Resume a previous session
  owlcoda --model <name>        Pick a model by id, alias, or partial match

Setup & diagnostics:
  owlcoda init                  Create config.json (--router URL, --force)
  owlcoda config                Show active configuration and resolved models
  owlcoda doctor                Environment health (Node/router/models/skills/etc.)
  owlcoda validate              Validate config file (schema + semantics)
  owlcoda health                Check proxy, local runtime, and model health
  owlcoda models                Show configured models and runtime visibility
  owlcoda inspect               Recent request/response exchanges
  owlcoda audit [--errors] [--slow N]   Query request audit log
  owlcoda cache [--clear]       Response cache stats
  owlcoda logs                  Show recent log entries
  owlcoda export [--json|--env] Export sanitized config for sharing
  owlcoda benchmark             Latency/throughput benchmark across models
  owlcoda completions <shell>   Generate shell completion (bash/zsh/fish)

Daemon & live clients:
  owlcoda start                 Start proxy in background (daemon only)
  owlcoda stop [--force]        Stop background proxy
  owlcoda status                Daemon health + live client registry
  owlcoda server                Start proxy server in foreground
  owlcoda serve                 Standalone API server (preflight + health)
  owlcoda clients               List active live REPL clients
  owlcoda clients detach <id> [--force]   Detach a client

Browser admin:
  owlcoda ui                    Print one-shot admin URL (use --open-browser)
  owlcoda admin                 Alias for \`owlcoda ui\`
  owlcoda ui --route <r> --select <id>    Focused admin handoff URL

Sessions & skills:
  owlcoda sessions              List recent sessions (--limit N, --tag T, --json)
  owlcoda skills                List learned skills (alias of \`skills list\`)
  owlcoda skills info|list|show|synth|delete|export|import
  owlcoda skills stats|cleanup|search|match

Training data (opt-in):
  owlcoda training status       Collection statistics
  owlcoda training scan         Batch-score historical sessions
  owlcoda training report       Quality distribution
  owlcoda training export [fmt] Export jsonl|sharegpt|insights
  owlcoda training clear        Clear collected data
  owlcoda training path         Print training data file path

Options:
  --port <N>              Override listen port
  --config, -c <path>     Path to config file
  --router, -r <url>      Override router URL
  --model, -m <name>      Select model (platform ID, alias, or partial match)
  --daemon-only           Ensure proxy daemon only, don't open REPL
  -p, --prompt <text>     Prompt text for non-interactive run
  --json                  JSON output mode (non-interactive)
  --auto-approve          Auto-approve all tool executions (non-interactive)
  --resume [id|last]      Resume a previous session
  --dry-run               Validate environment without launching
  --print-url             Print the browser admin URL without opening a browser
  --open-browser         Launch the browser admin URL in your default browser
  --route <name>          Admin browser route: models | aliases | orphans | catalog
  --select <modelId>      Preselect a model in the browser admin
  --view <name>           Optional browser admin subview/filter hint
  --force                 Force overwrite or force-detach clients for lifecycle control
  --help, -h              Show this help
  --version, -v           Show version

Interactive Mode:
  OwlCoda launches its native REPL by default with 42+ tools and 69+ commands.
  Multiple live REPL clients can share one daemon; session affinity prevents cross-client resume theft.
  Use "owlcoda clients" to inspect or detach live clients without stopping the daemon.

Non-Interactive / Piping:
  owlcoda run --prompt "explain this code"
  owlcoda run --model distilled --prompt "hello"
  echo "hello" | owlcoda run
  cat file.ts | owlcoda run --prompt "review this"

Exit Codes:
  0  Success
  1  Preflight / startup failure
  2  Model / proxy error
  3  Tool execution loop limit`)
}

export async function doStart(configPath?: string, port?: number, routerUrl?: string): Promise<void> {
  const config = loadEffectiveConfig(configPath, port, routerUrl)
  const baseUrl = getBaseUrl(config)

  const { pid, reused } = await ensureProxyRunning(config, configPath, port, routerUrl)

  if (reused) {
    if (pid > 0) {
      console.error(`owlcoda proxy already running with matching config (PID ${pid})`)
    } else {
      console.error(`owlcoda proxy already running with matching config at ${baseUrl}`)
    }
    return
  }

  console.error(`owlcoda proxy started in background (PID ${pid})`)
  console.error(`Listening: ${baseUrl}`)
  console.error(`Local runtime: ${config.routerUrl}`)
}

export async function doStop(force = false): Promise<void> {
  const pid = readPid()
  if (pid === null) {
    console.error('owlcoda is not running (no PID file)')
    process.exit(1)
  }
  if (!isPidAlive(pid)) {
    console.error(`owlcoda process ${pid} is not running (stale PID file)`)
    removePid()
    removeRuntimeMeta()
    process.exit(1)
  }

  const meta = readRuntimeMeta()
  if (!meta || meta.pid !== pid) {
    console.error(`PID ${pid} is alive but runtime metadata is missing or mismatched`)
    console.error('Clearing stale OwlCoda state without signaling. If this is an OwlCoda process, stop it manually.')
    removePid()
    removeRuntimeMeta()
    process.exit(1)
  }

  const healthz = await verifyManagedDaemon(meta)
  if (!healthz) {
    console.error(`PID ${pid} is alive but cannot verify against OwlCoda healthz/runtime metadata`)
    console.error('Clearing stale OwlCoda state without signaling. If this is an OwlCoda process, stop it manually.')
    removePid()
    removeRuntimeMeta()
    process.exit(1)
  }

  const activeClients = getActiveLiveClientsForRuntime(meta)
  if (activeClients.length > 0) {
    if (force) {
      const detached = detachLiveReplClientsForRuntime({
        host: meta.host,
        port: meta.port,
        routerUrl: meta.routerUrl,
        runtimeToken: meta.runtimeToken,
      }, { force: true })
      console.error(`Force-detached ${detached.removedClients.length} live REPL client${detached.removedClients.length === 1 ? '' : 's'} from ${getMetaBaseUrl(meta)} before stop.`)
    } else {
    console.error(`owlcoda daemon has ${activeClients.length} active live REPL client${activeClients.length === 1 ? '' : 's'} at ${getMetaBaseUrl(meta)}`)
    printActiveLiveClientDetails(activeClients)
    console.error('Refusing to stop the daemon while interactive clients are active.')
    process.exit(1)
    }
  }

  await stopAndWait(pid, getMetaBaseUrl(meta))
  console.error(`owlcoda stopped (PID ${pid})`)
}

export async function doStatus(): Promise<void> {
  const pid = readPid()
  if (pid === null) {
    console.error('owlcoda is not running (no PID file)')
    process.exit(1)
  }
  if (!isPidAlive(pid)) {
    console.error(`owlcoda is not running (stale PID file for ${pid})`)
    removePid()
    removeRuntimeMeta()
    process.exit(1)
  }

  // Verify via runtime meta + healthz
  const meta = readRuntimeMeta()
  if (!meta || meta.pid !== pid) {
    console.error(`owlcoda PID ${pid} alive but identity unverified (runtime metadata missing or mismatched)`)
    process.exit(1)
  }

  const healthz = await verifyManagedDaemon(meta)
  if (!healthz) {
    console.error(`owlcoda PID ${pid} alive but healthz/runtime metadata verification failed`)
    process.exit(1)
  }

  const baseUrl = getMetaBaseUrl(meta)
  console.error(`owlcoda is running (PID ${pid})`)
  console.error(`  Listening: ${baseUrl}`)
  console.error(`  Local runtime: ${meta.routerUrl}`)
  console.error(`  Version: ${meta.version}`)
  console.error(`  Started: ${meta.startedAt}`)
  const activeClients = getActiveLiveClientsForRuntime(meta)
  console.error(`  Live REPL clients: ${activeClients.length} active`)
  if (activeClients.length > 0) {
    printActiveLiveClientDetails(activeClients)
  }

  // Fetch enriched status from proxy endpoints
  try {
    const [healthRes, infoRes, metricsRes] = await Promise.allSettled([
      fetch(`${baseUrl}/healthz`).then(r => r.json() as Promise<Record<string, unknown>>),
      fetch(`${baseUrl}/v1/api-info`).then(r => r.json() as Promise<Record<string, unknown>>),
      fetch(`${baseUrl}/metrics`).then(r => r.json() as Promise<Record<string, unknown>>),
    ])

    if (healthRes.status === 'fulfilled') {
      const h = healthRes.value
      const status = typeof h.status === 'string' ? h.status : 'unknown'
      const icon = status === 'healthy' ? '✅' : status === 'degraded' ? '⚠️' : '❌'
      console.error(`  Health: ${icon} ${status}`)
      const router = h.router as Record<string, unknown> | undefined
      if (router) {
        const latency = typeof router.latencyMs === 'number' ? `${router.latencyMs}ms` : '—'
        const models = typeof router.modelCount === 'number' ? router.modelCount : '?'
        console.error(`  Local runtime latency: ${latency}, visible models: ${models}`)
      }
    }

    if (infoRes.status === 'fulfilled') {
      const info = infoRes.value
      if (typeof info.modelCount === 'number') {
        console.error(`  Configured models: ${info.modelCount}`)
      }
    }

    if (metricsRes.status === 'fulfilled') {
      const m = metricsRes.value
      if (typeof m.totalRequests === 'number') {
        console.error(`  Requests: ${m.totalRequests} total, ${m.recentErrors ?? 0} recent errors`)
      }
      if (typeof m.activeRequests === 'number' && (m.activeRequests as number) > 0) {
        console.error(`  Active: ${m.activeRequests} in-flight`)
      }
      if (typeof m.uptime === 'number') {
        const secs = m.uptime as number
        const h = Math.floor(secs / 3600)
        const min = Math.floor((secs % 3600) / 60)
        console.error(`  Uptime: ${h}h ${min}m`)
      }
    }

    // Skill injection stats
    try {
      const statsRes = await fetch(`${baseUrl}/v1/skill-stats`).then(r => r.json() as Promise<Record<string, unknown>>)
      if (typeof statsRes.totalQueries === 'number' && statsRes.totalQueries > 0) {
        const hitRate = typeof statsRes.hitRate === 'number' ? (statsRes.hitRate * 100).toFixed(0) : '?'
        const avgMs = typeof statsRes.avgMatchMs === 'number' ? statsRes.avgMatchMs.toFixed(1) : '?'
        console.error(`  Skills: ${statsRes.totalQueries} injections, ${hitRate}% hit rate, ${avgMs}ms avg`)
      }
    } catch { /* skill-stats not available */ }
  } catch {
    // Enriched status unavailable — basic info already shown
  }
}

export async function doClients(passthroughArgs: string[], jsonOutput = false, force = false): Promise<void> {
  const action = passthroughArgs[0] ?? 'list'

  if (action === 'list') {
    const clients = listActiveLiveReplClients()
    const now = Date.now()
    const views = clients.map((c) => enrichLiveReplClientForAdmin(c, now))

    if (jsonOutput) {
      // Stable machine-readable shape. schemaVersion lets consumers
      // gate on format changes; bump it when field semantics change.
      process.stdout.write(JSON.stringify({
        schemaVersion: LIVE_REPL_CLIENT_ADMIN_SCHEMA_VERSION,
        count: views.length,
        clients: views,
      }, null, 2) + '\n')
      process.exit(0)
    }

    if (views.length === 0) {
      console.error('No active live REPL clients.')
      console.error('')
      console.error('Tip: live REPL clients are recorded when you run `owlcoda` interactively.')
      console.error('     Use `--json` for machine-readable output when you run this command in scripts.')
      process.exit(0)
    }

    const aliveCount = views.filter((v) => v.alive).length
    const staleCount = views.length - aliveCount
    const summary = staleCount > 0
      ? `Active live REPL clients: ${views.length} (${aliveCount} alive, ${staleCount} stale)`
      : `Active live REPL clients: ${views.length}`
    console.error(summary)
    console.error('')
    for (let i = 0; i < views.length; i++) {
      console.error(formatLiveReplClientDetail(views[i]!, i + 1))
      if (i < views.length - 1) console.error('')
    }
    if (staleCount > 0) {
      console.error('')
      console.error(`Tip: ${staleCount} stale entry(s) — the client process is gone but the registry still tracks it.`)
      console.error(`     Clean up with: owlcoda clients detach <clientId>`)
    }
    console.error('')
    console.error('See `owlcoda clients --json` for machine-readable output.')
    process.exit(0)
  }

  if (action !== 'detach' && action !== 'force-detach') {
    console.error('Usage: owlcoda clients [--json]')
    console.error('   or: owlcoda clients detach <clientId> [--force]')
    console.error('   or: owlcoda clients force-detach <clientId>')
    process.exit(1)
  }

  const clientId = passthroughArgs[1]?.trim()
  if (!clientId) {
    console.error(`Usage: owlcoda clients ${action} <clientId>${action === 'detach' ? ' [--force]' : ''}`)
    process.exit(1)
  }

  const forceDetach = force || action === 'force-detach'
  const result = detachLiveReplClient(clientId, { force: forceDetach })
  if (result.ok && result.client) {
    const wasAlive = forceDetach // force only actually matters when the client was alive
    const verb = forceDetach ? 'Force-detached' : 'Detached'
    console.error(`✓ ${verb} client ${clientId}`)
    console.error(`  ${formatLiveReplClientAdminSummary(result.client)}`)
    if (wasAlive) {
      // Force path: the registry entry is gone but the process might
      // still be running. Surface the PID so the caller can decide.
      console.error('')
      console.error(`  Note: the client process (PID ${result.client.clientPid}) may still be running.`)
      console.error(`        If it needs to be stopped too:  kill ${result.client.clientPid}`)
    }
    process.exit(0)
  }

  if (result.reason === 'active_requires_force' && result.client) {
    const view = enrichLiveReplClientForAdmin(result.client)
    console.error(`Client ${clientId} is still live — detach requires --force.`)
    console.error('')
    console.error(formatLiveReplClientDetail(view))
    console.error('')
    console.error(`To detach anyway (registry-only, keeps the process alive):`)
    console.error(`  owlcoda clients detach ${clientId} --force`)
    console.error('')
    console.error(`To also stop the client process:`)
    console.error(`  kill ${result.client.clientPid}`)
    process.exit(1)
  }

  console.error(`Live REPL client not found: ${clientId}`)
  const active = listActiveLiveReplClients()
  if (active.length > 0) {
    console.error('')
    console.error('Known clients:')
    for (const c of active) {
      console.error(`  ${c.clientId}  PID ${c.clientPid}  started ${formatLiveReplClientAge(Math.max(0, Math.floor((Date.now() - Date.parse(c.startedAt)) / 1000)))} ago`)
    }
  }
  process.exit(1)
}

export async function doServe(configPath?: string, port?: number, routerUrl?: string): Promise<void> {
  const config = loadEffectiveConfig(configPath, port, routerUrl)
  const baseUrl = getBaseUrl(config)

  // Preflight check
  const preflight = await runPreflight(config)
  console.error(formatPreflightForCli(preflight))

  if (!preflight.canProceed) {
    console.error('\nCannot start serve mode — no backends available.')
    process.exit(1)
  }

  console.error('')
  console.error(`OwlCoda API Server v${VERSION}`)
  console.error(`  Listening: ${baseUrl}`)
  console.error(`  Local runtime: ${config.routerUrl}`)
  console.error(`  Models:    ${config.models.map(m => m.id).join(', ')}`)
  console.error(`  Endpoints: /v1/messages, /v1/models, /v1/usage, /health, /v1/api-info`)
  console.error('')
  console.error('Press Ctrl+C to stop.')

  startServer(config)

  // Keep process alive — startServer already handles SIGINT/SIGTERM
  await new Promise<void>(() => {})
}

export interface UiLaunchResult {
  url: string
  bundleAvailable: boolean
  openedBrowser: boolean
  context: AdminHandoffContext
}

export interface UiLaunchDeps {
  ensureProxyRunning: typeof ensureProxyRunning
  readRuntimeMeta: typeof readRuntimeMeta
  getMetaBaseUrl: typeof getMetaBaseUrl
  getBaseUrl: typeof getBaseUrl
  openUrlInBrowser: (url: string) => boolean
  now: () => number
  getAdminBundleStatus: typeof getAdminBundleStatus
}

const defaultUiLaunchDeps: UiLaunchDeps = {
  ensureProxyRunning,
  readRuntimeMeta,
  getMetaBaseUrl,
  getBaseUrl,
  openUrlInBrowser,
  getAdminBundleStatus,
  now: () => Date.now(),
}

export async function doUi(
  configPath?: string,
  port?: number,
  routerUrl?: string,
  options: { printUrl?: boolean, openBrowser?: boolean, route?: AdminHandoffContext['route'], select?: string, view?: string } = {},
  deps: UiLaunchDeps = defaultUiLaunchDeps,
): Promise<UiLaunchResult> {
  const config = loadEffectiveConfig(configPath, port, routerUrl)
  await deps.ensureProxyRunning(config, configPath, port, routerUrl)
  const runtimeMeta = deps.readRuntimeMeta()
  const baseUrl = runtimeMeta ? deps.getMetaBaseUrl(runtimeMeta) : deps.getBaseUrl(config)
  const bundleStatus = deps.getAdminBundleStatus()
  const token = createOneShotAdminToken(getAdminBearerToken(config), { now: deps.now })
  const context: AdminHandoffContext = {
    route: options.route,
    select: options.select,
    view: options.view,
  }
  const url = buildAdminHandoffUrl(baseUrl, token, context)

  if (!bundleStatus.available) {
    console.error(`Admin bundle is not built yet: expected ${bundleStatus.indexPath}`)
    console.error('The server will return a friendly /admin bundle-missing page until the browser bundle exists.')
  }

  const shouldOpenBrowser = !options.printUrl && shouldAutoOpenAdminBrowser(options.openBrowser)

  if (!shouldOpenBrowser) {
    process.stdout.write(url + '\n')
    if (!options.printUrl) {
      console.error(adminAutoOpenDisabledHint())
    }
    console.error(adminHandoffFailureHint())
    return { url, bundleAvailable: bundleStatus.available, openedBrowser: false, context }
  }

  let openedBrowser = false
  if (bundleStatus.available) {
    openedBrowser = deps.openUrlInBrowser(url)
    if (openedBrowser) {
      console.error('Opened OwlCoda Admin in your default browser.')
    } else {
      console.error('Could not open a browser automatically.')
    }
  } else {
    console.error('Skipping automatic browser open because the admin bundle is missing.')
  }

  console.error(`Admin URL: ${url}`)
  console.error(adminHandoffFailureHint())
  return { url, bundleAvailable: bundleStatus.available, openedBrowser, context }
}

export async function doLaunch(
  configPath?: string,
  port?: number,
  routerUrl?: string,
  resumeSession?: string,
  model?: string,
): Promise<void> {
  const config = loadEffectiveConfig(configPath, port, routerUrl)
  const baseUrl = getBaseUrl(config)
  const quietStartup = Boolean(process.stderr.isTTY) && !isLaunchStartupVerbose()

  // Startup banner
  const modelCount = config.models?.length ?? 0
  const defaultModel = getPreferredInteractiveConfiguredModel(config)
  if (!quietStartup) {
    console.error(`\n🦉 OwlCoda v${VERSION}`)
    console.error(`   Mode: native · Models: ${modelCount} · Local runtime: ${config.routerUrl}`)
    if (defaultModel) {
      const defaultLine = defaultModel.id === defaultModel.backendModel
        ? defaultModel.id
        : `${defaultModel.id} → ${defaultModel.backendModel}`
      console.error(`   Default: ${defaultLine}`)
    }
    if (model) console.error(`   Selected: ${model}`)
    console.error('')
  }

  const apiKey = 'owlcoda-local-key-' + String(config.port)

  // 1. Run local platform preflight
  const preflight = await runPreflight(config)
  if (!quietStartup) {
    console.error('')
    console.error(formatPreflightForCli(preflight))
    console.error('')
  }

  if (!preflight.canProceed) {
    if (quietStartup) {
      console.error(formatPreflightForCli(preflight))
      console.error('')
    }
    console.error('Cannot start OwlCoda — local platform services are not available.')
    console.error('Please start the required services and try again.')
    process.exit(1)
  }

  // 2. Ensure proxy is running with matching config
  const { pid, reused } = await ensureProxyRunning(config, configPath, port, routerUrl, { quiet: quietStartup })
  if (!quietStartup) {
    if (reused && pid > 0) {
      console.error(`OwlCoda proxy: reusing PID ${pid} on ${baseUrl}`)
    } else if (reused) {
      console.error(`OwlCoda proxy: reusing on ${baseUrl}`)
    } else {
      console.error(`OwlCoda proxy: started PID ${pid} on ${baseUrl}`)
    }
  }

  // 3. ensureProxyRunning only returns once the daemon is verified ready
  if (!quietStartup) {
    console.error('OwlCoda proxy: ready')
  }

  const runtimeMeta = readRuntimeMeta()
  if (!runtimeMeta || runtimeMeta.port !== config.port || runtimeMeta.routerUrl !== config.routerUrl) {
    console.error('Failed to resolve live REPL lease metadata for the active daemon.')
    process.exit(1)
  }

  const effectiveResumeSession = resolveResumeSessionTarget(resumeSession, runtimeMeta, 'launch')
  const clientId = createLiveReplClientId()
  upsertLiveReplClient({
    clientId,
    clientPid: process.pid,
    daemonPid: runtimeMeta.pid,
    runtimeToken: runtimeMeta.runtimeToken,
    host: config.host,
    port: config.port,
    routerUrl: config.routerUrl,
    startedAt: new Date().toISOString(),
    sessionId: effectiveResumeSession,
  })

  // 4. Launch frontend — native is the only interactive path
  const { startRepl: startNativeRepl } = await import('./native/repl.js')
  const selectedModel = model ?? defaultModel?.id ?? 'default'
  try {
    await startNativeRepl({
      apiBaseUrl: baseUrl,
      apiKey,
      model: selectedModel,
      maxTokens: 4096,
      resumeSession: effectiveResumeSession,
      liveReplClientId: clientId,
      liveReplRuntime: {
        host: runtimeMeta.host,
        port: runtimeMeta.port,
        routerUrl: runtimeMeta.routerUrl,
        runtimeToken: runtimeMeta.runtimeToken,
      },
    })
  } finally {
    removeLiveReplClientIfOwned(clientId, process.pid)
  }
}

// ─── Main ───

export async function main(): Promise<void> {
  const {
    command: parsedCommand,
    port,
    configPath,
    routerUrl,
    model,
    daemonOnly,
    prompt,
    jsonOutput,
    autoApprove,
    resumeSession,
    force,
    dryRun,
    printUrl,
    openBrowser,
    route,
    select,
    view,
    passthroughArgs,
  } = parseArgs(process.argv)

  // Top-level `-p` / `--prompt` is documented (README, CHANGELOG, smoke
  // tests) as a shorthand for `owlcoda run --prompt …`. The parser captures
  // it; route a default `launch` invocation that carries a prompt through
  // the headless `run` path so the documented behavior actually fires
  // instead of dropping the user into the REPL.
  let command: typeof parsedCommand = parsedCommand
  if (command === 'launch' && prompt !== undefined) {
    command = 'run'
  }

  switch (command) {
    case 'help':
      printHelp()
      process.exit(0)
    case 'version': {
      console.error(`owlcoda ${VERSION} — native mode`)
      console.error(`  42+ tools · 69+ commands · local model routing · session persistence`)
      console.error(`  node ${process.version} · platform: ${process.platform}`)
      process.exit(0)
    }
    case 'start':
      await doStart(configPath, port, routerUrl)
      break
    case 'stop':
      await doStop(force)
      break
    case 'status':
      await doStatus()
      break
    case 'clients':
      await doClients(passthroughArgs, jsonOutput, force)
      break
    case 'server': {
      const config = loadEffectiveConfig(configPath, port, routerUrl)
      startServer(config)
      break
    }
    case 'serve': {
      await doServe(configPath, port, routerUrl)
      break
    }
    case 'doctor': {
      const { runDoctor, formatDoctorReport } = await import('./doctor.js')
      const report = await runDoctor(configPath)
      console.error(formatDoctorReport(report))
      process.exit(report.failCount > 0 ? 1 : 0)
    }
    case 'ui': {
      await doUi(configPath, port, routerUrl, { printUrl, openBrowser, route, select, view })
      process.exit(0)
    }
    case 'sessions': {
      // Use native session store directly (unified at ~/.owlcoda/sessions/)
      const { listSessions } = await import('./native/session.js')
      const limit = passthroughArgs.includes('--limit')
        ? parseInt(passthroughArgs[passthroughArgs.indexOf('--limit') + 1] || '20', 10)
        : 20
      const tag = passthroughArgs.includes('--tag')
        ? passthroughArgs[passthroughArgs.indexOf('--tag') + 1]
        : undefined

      let sessions = listSessions()
      if (tag) {
        sessions = sessions.filter(s => s.tags?.includes(tag))
      }
      sessions = sessions.slice(0, limit)

      if (passthroughArgs.includes('--json')) {
        process.stdout.write(JSON.stringify(sessions, null, 2) + '\n')
      } else {
        if (sessions.length === 0) {
          console.error('No sessions found.')
        } else {
          console.error(`\n📜 Recent sessions (${sessions.length}):\n`)
          for (const s of sessions) {
            const date = new Date(s.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
            const tags = s.tags?.length ? ` [${s.tags.join(', ')}]` : ''
            // Extract preview from first user turn
            const firstUser = s.turns.find(t => t.role === 'user')
            const previewText = firstUser?.content
              ?.map((b: any) => (b.type === 'text' ? b.text : '')).join('')
              ?.slice(0, 60).replace(/\n/g, ' ') ?? ''
            console.error(`  ${s.id.slice(0, 8)}  ${date}  ${s.turns.length}t  ${s.model}`)
            if (previewText) console.error(`           ${previewText}${previewText.length >= 60 ? '…' : ''}${tags}`)
          }
          console.error(`\n  Resume: owlcoda --resume <id>\n`)
        }
      }
      process.exit(0)
    }
    case 'init': {
      const { runInit, formatInitResult } = await import('./init.js')
      const result = await runInit({ routerUrl, port, force })
      console.error(formatInitResult(result))
      process.exit(result.created ? 0 : 1)
    }
    case 'config': {
      const { getConfigDisplay, formatConfigDisplay } = await import('./config-display.js')
      const display = getConfigDisplay(configPath)
      console.error(formatConfigDisplay(display))
      process.exit(0)
    }
    case 'models': {
      const { getModelsDisplay, formatModelsDisplay } = await import('./models-display.js')
      const display = await getModelsDisplay(configPath)
      console.error(formatModelsDisplay(display))
      process.exit(0)
    }
    case 'benchmark': {
      const config = loadEffectiveConfig(configPath, port, routerUrl)
      const baseUrl = getBaseUrl(config)
      const modelIds = config.models.map(m => m.id)
      if (modelIds.length === 0) {
        console.error('No models configured. Run `owlcoda init` first.')
        process.exit(1)
      }
      // Ensure proxy is running before benchmarking
      await ensureProxyRunning(config, configPath, port, routerUrl)
      console.error(`Benchmarking ${modelIds.length} model(s) via ${baseUrl}...`)
      const { runBenchmark, formatBenchmarkReport } = await import('./benchmark.js')
      const report = await runBenchmark(baseUrl, modelIds)
      console.error(formatBenchmarkReport(report))
      process.exit(report.results.every(r => r.success) ? 0 : 1)
      break
    }
    case 'export': {
      const { createExport, formatExport } = await import('./export.js')
      const format = jsonOutput ? 'json' : passthroughArgs.includes('--env') ? 'env' : 'text'
      const result = createExport(configPath)
      const output = formatExport(result, format)
      if (format === 'json' || format === 'env') {
        process.stdout.write(output + '\n')
      } else {
        console.error(output)
      }
      process.exit(0)
    }
    case 'inspect': {
      // Fetch captures from running proxy via runtime metadata
      const meta = readRuntimeMeta()
      if (!meta) {
        console.error('owlcoda is not running. Start the proxy first.')
        process.exit(1)
      }
      const baseUrl = getMetaBaseUrl(meta)
      try {
        const resp = await fetch(`${baseUrl}/v1/captures`, { signal: AbortSignal.timeout(5000) })
        if (!resp.ok) {
          console.error(`Failed to fetch captures: HTTP ${resp.status}`)
          process.exit(1)
        }
        const data = await resp.json() as { captures: unknown[]; stats: Record<string, unknown> }
        if (jsonOutput) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n')
        } else {
          const { formatCaptures } = await import('./capture.js')
          console.error(formatCaptures(data.captures as import('./capture.js').CapturedExchange[]))
          const stats = data.stats
          if (typeof stats.totalExchanges === 'number' && stats.totalExchanges > 0) {
            console.error('')
            console.error(`  Total: ${stats.totalExchanges}, Avg: ${stats.avgDurationMs}ms, Error rate: ${(stats.errorRate as number * 100).toFixed(0)}%`)
          }
        }
      } catch (err) {
        console.error(`Cannot reach proxy at ${baseUrl}: ${err instanceof Error ? err.message : err}`)
        process.exit(1)
      }
      process.exit(0)
    }
    case 'logs': {
      const config = loadEffectiveConfig(configPath, port, routerUrl)
      const logPath = config.logFilePath
      if (!logPath) {
        console.error('No logFilePath configured. Add "logFilePath" to config.json.')
        process.exit(1)
      }
      if (!existsSync(logPath)) {
        console.error(`Log file not found: ${logPath}`)
        console.error('The proxy may not have started yet, or the path is incorrect.')
        process.exit(1)
      }
      const { readFileSync } = await import('node:fs')
      const content = readFileSync(logPath, 'utf-8')
      const lines = content.trimEnd().split('\n')
      const tail = lines.slice(-50) // show last 50 lines
      console.error(`Log file: ${logPath} (${lines.length} lines, showing last ${tail.length})`)
      console.error('─'.repeat(50))
      for (const line of tail) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>
          const ts = typeof entry.ts === 'string' ? entry.ts.slice(11, 19) : ''
          const level = (typeof entry.level === 'string' ? entry.level : '').toUpperCase().padEnd(5)
          const component = typeof entry.component === 'string' ? `[${entry.component}]` : ''
          const msg = typeof entry.msg === 'string' ? entry.msg : ''
          console.error(`${ts} ${level} ${component} ${msg}`)
        } catch {
          console.error(line)
        }
      }
      process.exit(0)
    }
    case 'validate': {
      const { runValidation, formatValidationResult } = await import('./validate.js')
      const result = runValidation(configPath)
      console.error(formatValidationResult(result))
      const hasErrors = result.issues.some(i => i.level === 'error')
      process.exit(hasErrors ? 1 : 0)
    }
    case 'health': {
      const config = loadEffectiveConfig(configPath, port, routerUrl)
      const baseUrl = getBaseUrl(config)
      const { checkPorts } = await import('./port-utils.js')
      const { getAllModelHealth } = await import('./health-monitor.js')

      console.error('🏥 Health Check')
      console.error('─'.repeat(40))

      // Port check
      const ports = await checkPorts({ port: config.port, routerUrl: config.routerUrl })
      console.error(`\nPorts:`)
      console.error(`  Proxy ${ports.proxyPort}: ${ports.proxyAvailable ? '🟡 available (not running)' : '🟢 in use (likely running)'}`)
      if (ports.routerPort !== null) {
        console.error(`  Local runtime ${ports.routerPort}: ${ports.routerAvailable ? '🟢 reachable' : '🔴 not responding'}`)
      }

      // Proxy healthz
      console.error(`\nProxy:`)
      try {
        const resp = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(3000) })
        if (resp.ok) {
          const data = await resp.json() as Record<string, unknown>
          console.error(`  🟢 Healthy — uptime: ${data.uptime ?? '?'}s, active: ${data.activeRequests ?? 0}`)
        } else {
          console.error(`  🟡 Degraded — HTTP ${resp.status}`)
        }
      } catch {
        console.error(`  🔴 Unreachable at ${baseUrl}`)
      }

      // Local runtime visibility
      console.error(`\nLocal runtime:`)
      try {
        const { probeRuntimeSurface } = await import('./runtime-probe.js')
        const probe = await probeRuntimeSurface(config.routerUrl, 3000)
        if (probe.ok) {
          console.error(`  🟢 ${probe.detail}`)
        } else {
          console.error(`  🔴 ${probe.detail}`)
        }
      } catch {
        console.error(`  🔴 Unreachable at ${config.routerUrl}`)
      }

      // Model health cache
      const modelHealth = getAllModelHealth()
      if (Object.keys(modelHealth).length > 0) {
        console.error(`\nModel Health:`)
        for (const [id, h] of Object.entries(modelHealth)) {
          const icon = h.status === 'healthy' ? '🟢' : h.status === 'unhealthy' ? '🔴' : '⚪'
          console.error(`  ${icon} ${id} — ${h.latencyMs}ms`)
        }
      }

      process.exit(0)
    }
    case 'audit': {
      const meta = readRuntimeMeta()
      if (!meta) {
        console.error('owlcoda is not running. Start the proxy first.')
        process.exit(1)
      }
      const baseUrl = getMetaBaseUrl(meta)
      const params = new URLSearchParams()
      // Parse filter args from passthroughArgs: --model X, --errors, --slow N, --limit N
      for (let i = 0; i < passthroughArgs.length; i++) {
        const arg = passthroughArgs[i]
        if (arg === '--errors') params.set('minStatus', '400')
        else if (arg === '--slow' && passthroughArgs[i + 1]) params.set('minDurationMs', passthroughArgs[++i])
        else if (arg === '--limit' && passthroughArgs[i + 1]) params.set('limit', passthroughArgs[++i])
        else if (arg === '--model' && passthroughArgs[i + 1]) params.set('model', passthroughArgs[++i])
      }
      if (!params.has('limit')) params.set('limit', '20')
      try {
        const resp = await fetch(`${baseUrl}/v1/audit?${params}`, { signal: AbortSignal.timeout(5000) })
        if (!resp.ok) {
          console.error(`Failed to fetch audit log: HTTP ${resp.status}`)
          process.exit(1)
        }
        const data = await resp.json() as { entries: Array<Record<string, unknown>>; summary: Record<string, unknown> }
        if (jsonOutput) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n')
        } else {
          const { formatAuditEntries } = await import('./audit-log.js')
          console.error(formatAuditEntries(data.entries as any))
          console.error('')
          const s = data.summary
          console.error(`Summary: ${s.totalEntries} total, ${s.errorCount} errors, avg ${s.avgDurationMs}ms`)
        }
      } catch (err) {
        console.error(`Cannot reach proxy at ${baseUrl}: ${err instanceof Error ? err.message : err}`)
        process.exit(1)
      }
      process.exit(0)
    }
    case 'skills': {
      const subCmd = passthroughArgs[0] ?? 'list'
      const skillArg = passthroughArgs[1] ?? ''

      if (subCmd === 'info') {
        const { loadAllSkills, loadLearnedSkills } = await import('./skills/store.js')
        const { loadCuratedSkills } = await import('./skills/curated.js')
        const curated = await loadCuratedSkills()
        const learned = await loadLearnedSkills()
        const all = await loadAllSkills()

        if (passthroughArgs.includes('--json')) {
          process.stdout.write(JSON.stringify({
            total: all.length,
            curated: curated.length,
            learned: learned.length,
            topTags: getTopTags(all),
          }, null, 2) + '\n')
        } else {
          console.error(`\n🧠 Skill System Overview\n`)
          console.error(`  Total skills:    ${all.length}`)
          console.error(`  📦 Curated:      ${curated.length}`)
          console.error(`  📘 Learned:      ${learned.length}`)
          const tags = getTopTags(all)
          if (tags.length > 0) {
            console.error(`\n  Top tags:`)
            for (const [tag, count] of tags.slice(0, 10)) {
              console.error(`    ${tag} (${count})`)
            }
          }
          console.error(`\n  Commands:`)
          console.error(`    owlcoda skills list       List learned skills`)
          console.error(`    owlcoda skills search <q>  Browse by keyword`)
          console.error(`    owlcoda skills match <q>   TF-IDF matching`)
          console.error(`    owlcoda skills stats       Injection health report`)
          console.error('')
        }
        process.exit(0)
      }

      if (subCmd === 'list' || subCmd === undefined) {
        // Local filesystem listing (no daemon needed)
        const { listSkills } = await import('./skills/store.js')
        const skills = await listSkills()
        if (skills.length === 0) {
          console.error('No learned skills yet.')
          console.error('Use "owlcoda skills synth <session-id>" to synthesize from a session.')
          process.exit(0)
        }
        if (jsonOutput) {
          process.stdout.write(JSON.stringify(skills, null, 2) + '\n')
        } else {
          console.error(`Learned Skills (${skills.length}):`)
          for (const s of skills) {
            const tags = s.tags.length > 0 ? ` [${s.tags.slice(0, 4).join(', ')}]` : ''
            console.error(`  ${s.id}  — ${s.description || s.name}${tags}  (used ${s.useCount}×)`)
          }
        }
        process.exit(0)
      }

      if (subCmd === 'show') {
        if (!skillArg) { console.error('Usage: owlcoda skills show <id>'); process.exit(1) }
        const { loadSkill } = await import('./skills/store.js')
        const { renderSkillMd } = await import('./skills/schema.js')
        const skill = await loadSkill(skillArg)
        if (!skill) { console.error(`Skill '${skillArg}' not found.`); process.exit(1) }
        if (jsonOutput) {
          process.stdout.write(JSON.stringify(skill, null, 2) + '\n')
        } else {
          process.stdout.write(renderSkillMd(skill) + '\n')
        }
        process.exit(0)
      }

      if (subCmd === 'synth') {
        if (!skillArg) { console.error('Usage: owlcoda skills synth <session-id>'); process.exit(1) }
        const { loadSession } = await import('./history/sessions.js')
        const { analyzeSession } = await import('./skills/trace-analyzer.js')
        const { synthesize, isWorthSynthesizing } = await import('./skills/synthesizer.js')
        const { saveSkill } = await import('./skills/store.js')
        const { invalidateSkillIndex } = await import('./skills/injection.js')
        const { renderSkillMd } = await import('./skills/schema.js')

        const session = await loadSession(skillArg)
        if (!session) { console.error(`Session '${skillArg}' not found.`); process.exit(1) }

        console.error(`Analyzing session ${skillArg} (${session.meta.messageCount} messages)...`)
        const trace = analyzeSession(session)
        const check = isWorthSynthesizing(trace)
        if (!check.worth) {
          console.error(`Session not complex enough to synthesize: ${check.reason}`)
          process.exit(1)
        }

        console.error(`Complexity: ${trace.complexity}/100, tools: ${trace.toolsUsed.join(', ')}`)
        const result = await synthesize(trace, { mode: 'template' })
        await saveSkill(result.skill)
        invalidateSkillIndex()

        if (result.warnings.length > 0) {
          for (const w of result.warnings) console.error(`  ⚠ ${w}`)
        }

        if (jsonOutput) {
          process.stdout.write(JSON.stringify(result.skill, null, 2) + '\n')
        } else {
          console.error(`\n✓ Skill synthesized: ${result.skill.id} (confidence: ${(result.confidence * 100).toFixed(0)}%)`)
          console.error('')
          process.stdout.write(renderSkillMd(result.skill) + '\n')
        }
        process.exit(0)
      }

      if (subCmd === 'delete') {
        if (!skillArg) { console.error('Usage: owlcoda skills delete <id>'); process.exit(1) }
        const { deleteSkill } = await import('./skills/store.js')
        const { invalidateSkillIndex } = await import('./skills/injection.js')
        const deleted = await deleteSkill(skillArg)
        if (!deleted) { console.error(`Skill '${skillArg}' not found.`); process.exit(1) }
        invalidateSkillIndex()
        console.error(`Deleted skill: ${skillArg}`)
        process.exit(0)
      }

      if (subCmd === 'export') {
        const { exportSkills } = await import('./skills/store.js')
        const ids = skillArg ? passthroughArgs.slice(1) : undefined
        const bundle = await exportSkills(ids)
        process.stdout.write(JSON.stringify(bundle, null, 2) + '\n')
        console.error(`Exported ${bundle.skills.length} skill(s)`)
        process.exit(0)
      }

      if (subCmd === 'import') {
        if (!skillArg) { console.error('Usage: owlcoda skills import <file.json> [--overwrite]'); process.exit(1) }
        const { readFile } = await import('node:fs/promises')
        const { importSkills } = await import('./skills/store.js')
        const { invalidateSkillIndex } = await import('./skills/injection.js')
        let raw: string
        try {
          raw = await readFile(skillArg, 'utf-8')
        } catch {
          console.error(`Cannot read file: ${skillArg}`)
          process.exit(1)
        }
        const bundle = JSON.parse(raw)
        const overwrite = passthroughArgs.includes('--overwrite')
        const result = await importSkills(bundle, overwrite)
        invalidateSkillIndex()
        console.error(`Imported: ${result.imported}, Skipped: ${result.skipped}`)
        if (result.errors.length > 0) {
          for (const e of result.errors) console.error(`  ⚠ ${e}`)
        }
        if (jsonOutput) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n')
        }
        process.exit(0)
      }

      if (subCmd === 'stats') {
        const { loadAllSkills, loadLearnedSkills } = await import('./skills/store.js')
        const { loadCuratedSkills } = await import('./skills/curated.js')
        const allSkills = await loadAllSkills()
        const learned = await loadLearnedSkills()
        let curatedCount = 0
        try {
          const curated = await loadCuratedSkills()
          curatedCount = curated.length
        } catch { /* ignore */ }

        if (allSkills.length === 0) {
          console.error('No skills loaded.')
          process.exit(0)
        }

        const totalUses = allSkills.reduce((s, sk) => s + sk.useCount, 0)
        const neverUsed = allSkills.filter(sk => sk.useCount === 0).length
        const mostUsed = [...allSkills].sort((a, b) => b.useCount - a.useCount).slice(0, 5)
        const avgTags = allSkills.reduce((s, sk) => s + sk.tags.length, 0) / allSkills.length
        const now = Date.now()
        const freshDays = 30
        const fresh = learned.filter(sk => (now - new Date(sk.updatedAt).getTime()) < freshDays * 86400000).length
        const stale = learned.length - fresh

        // Synthesis mode breakdown
        const modes: Record<string, number> = {}
        for (const sk of allSkills) {
          modes[sk.synthesisMode] = (modes[sk.synthesisMode] ?? 0) + 1
        }

        // Tag coverage
        const allTags = new Set<string>()
        for (const sk of allSkills) sk.tags.forEach(t => allTags.add(t))

        // Health score (0-100) — based on learned skills only
        const usageRate = learned.length > 0 ? (learned.length - learned.filter(sk => sk.useCount === 0).length) / learned.length : 0.5
        const freshnessRate = learned.length > 0 ? fresh / learned.length : 0.5
        const tagCoverage = Math.min(avgTags / 3, 1)
        const health = Math.round((usageRate * 40 + freshnessRate * 30 + tagCoverage * 30))

        if (jsonOutput) {
          process.stdout.write(JSON.stringify({
            total: allSkills.length,
            curated: curatedCount,
            learned: learned.length,
            totalUses,
            neverUsed,
            fresh,
            stale,
            avgTags: +avgTags.toFixed(1),
            uniqueTags: allTags.size,
            modes,
            health,
            topSkills: mostUsed.map(s => ({ id: s.id, useCount: s.useCount })),
          }, null, 2) + '\n')
        } else {
          const bar = '█'.repeat(Math.round(health / 5)) + '░'.repeat(20 - Math.round(health / 5))
          console.error(`\nSkill Library Health: ${health}/100 [${bar}]`)
          console.error(``)
          console.error(`  Total skills:    ${allSkills.length} (${curatedCount} curated + ${learned.length} learned)`)
          console.error(`  Total uses:      ${totalUses}`)
          console.error(`  Never used:      ${neverUsed}`)
          console.error(`  Fresh (<30d):    ${fresh} (learned only)`)
          console.error(`  Stale (>30d):    ${stale} (learned only)`)
          console.error(`  Avg tags/skill:  ${avgTags.toFixed(1)}`)
          console.error(`  Unique tags:     ${allTags.size}`)
          console.error(`  Synthesis modes: ${Object.entries(modes).map(([k, v]) => `${k}:${v}`).join(', ')}`)
          if (mostUsed.length > 0 && mostUsed[0].useCount > 0) {
            console.error(``)
            console.error(`  Top skills:`)
            for (const s of mostUsed) {
              if (s.useCount === 0) break
              console.error(`    ${s.id}  (${s.useCount}×)`)
            }
          }
          console.error('')
        }
        process.exit(0)
      }

      if (subCmd === 'cleanup') {
        const { cleanupSkills } = await import('./skills/store.js')
        const dryRun = !passthroughArgs.includes('--force')
        const staleDays = passthroughArgs.includes('--stale-days')
          ? parseInt(passthroughArgs[passthroughArgs.indexOf('--stale-days') + 1] || '90', 10)
          : 90
        const minUseCount = passthroughArgs.includes('--min-uses')
          ? parseInt(passthroughArgs[passthroughArgs.indexOf('--min-uses') + 1] || '3', 10)
          : 3

        const result = await cleanupSkills({ dryRun, staleDays, minUseCount })

        if (passthroughArgs.includes('--json')) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n')
        } else {
          console.log(`\n🧹 Skill Cleanup ${dryRun ? '(dry run)' : ''}`)
          console.log(`  Stale (>${staleDays}d, <${minUseCount} uses): ${result.stale.length}`)
          console.log(`  Unused (0 uses): ${result.unused.length}`)
          if (dryRun) {
            console.log(`  Would remove: ${result.stale.length} skills`)
            if (result.stale.length > 0) {
              console.log(`  Run with --force to delete\n`)
              for (const id of result.stale.slice(0, 10)) console.log(`    - ${id}`)
            }
          } else {
            console.log(`  Removed: ${result.removed.length}`)
            console.log(`  Kept: ${result.kept}`)
          }
          console.log()
        }
        process.exit(0)
      }

      if (subCmd === 'search') {
        const keyword = (skillArg || passthroughArgs.join(' ')).toLowerCase().trim()
        if (!keyword) { console.error('Usage: owlcoda skills search <keyword> [--json]'); process.exit(1) }
        const { loadAllSkills, loadLearnedSkills } = await import('./skills/store.js')
        const skills = await loadAllSkills()
        const learnedIds = new Set((await loadLearnedSkills()).map(s => s.id))
        const hits = skills.filter(s => {
          const haystack = [s.id, s.name, s.description, ...s.tags, ...(s.procedure ?? [])].join(' ').toLowerCase()
          return haystack.includes(keyword)
        })
        if (passthroughArgs.includes('--json')) {
          process.stdout.write(JSON.stringify(hits.map(s => ({
            id: s.id, name: s.name, description: s.description,
            source: learnedIds.has(s.id) ? 'learned' : 'curated',
            tags: s.tags,
          })), null, 2) + '\n')
        } else {
          if (hits.length === 0) {
            console.error(`No skills found matching "${keyword}"`)
          } else {
            console.error(`\n🔎 ${hits.length} skill${hits.length > 1 ? 's' : ''} matching "${keyword}":\n`)
            for (const s of hits) {
              const src = learnedIds.has(s.id) ? '📘' : '📦'
              const tags = s.tags.length > 0 ? ` [${s.tags.slice(0, 3).join(', ')}]` : ''
              console.error(`  ${src} ${s.id}${tags}`)
              if (s.description) console.error(`     ${s.description.slice(0, 80)}`)
            }
            console.error(`\n  📘 = learned  📦 = curated\n`)
          }
        }
        process.exit(0)
      }

      if (subCmd === 'match') {
        const query = skillArg || passthroughArgs.join(' ')
        if (!query) { console.error('Usage: owlcoda skills match <query> [--top N] [--threshold N] [--json]'); process.exit(1) }
        const { loadAllSkills, loadLearnedSkills } = await import('./skills/store.js')
        const { matchOne } = await import('./skills/matcher.js')
        const topK = passthroughArgs.includes('--top')
          ? parseInt(passthroughArgs[passthroughArgs.indexOf('--top') + 1] || '5', 10)
          : 5
        const threshold = passthroughArgs.includes('--threshold')
          ? parseFloat(passthroughArgs[passthroughArgs.indexOf('--threshold') + 1] || '0.05')
          : 0.05
        const skills = await loadAllSkills()
        const learnedIds = new Set((await loadLearnedSkills()).map(s => s.id))
        if (skills.length === 0) {
          console.error('No skills in library. Synthesize some first.')
          process.exit(1)
        }
        const results = matchOne(query, skills, { topK, threshold })
        if (passthroughArgs.includes('--json')) {
          process.stdout.write(JSON.stringify(results.map(r => ({
            id: r.skill.id, name: r.skill.name, score: Math.round(r.score * 1000) / 1000,
            source: learnedIds.has(r.skill.id) ? 'learned' : 'curated',
            tags: r.skill.tags, useCount: r.skill.useCount,
          })), null, 2) + '\n')
        } else {
          if (results.length === 0) {
            console.error(`No skills matched "${query}" (threshold: ${threshold})`)
          } else {
            console.error(`\n🔍 Skills matching "${query}" (${skills.length} indexed):\n`)
            for (const r of results) {
              const pct = (r.score * 100).toFixed(1)
              const barLen = Math.round(r.score * 40)
              const bar = '█'.repeat(barLen) + '░'.repeat(Math.max(0, 10 - barLen))
              const src = learnedIds.has(r.skill.id) ? '📘' : '📦'
              const tags = r.skill.tags.length > 0 ? ` [${r.skill.tags.slice(0, 3).join(', ')}]` : ''
              console.error(`  ${pct.padStart(5)}% ${bar} ${src} ${r.skill.id}${tags}`)
              if (r.skill.name !== r.skill.id) console.error(`                  ${r.skill.name}`)
            }
            console.error(`\n  📘 = learned  📦 = curated\n`)
          }
        }
        process.exit(0)
      }

      console.error(`Unknown skills subcommand: ${subCmd}`)
      console.error('Usage: owlcoda skills [list|show|synth|delete|export|import|stats|cleanup|search|match] [<id>]')
      process.exit(1)
    }
    case 'training': {
      const { readFile, readdir, rm, stat } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const trainingDir = join(process.env.OWLCODA_HOME ?? join(process.env.HOME ?? '/tmp', '.owlcoda'), 'training')
      const subCmd = passthroughArgs[0] ?? 'status'
      const jsonOutput = passthroughArgs.includes('--json')

      switch (subCmd) {
        case 'status': {
          try {
            const manifestRaw = await readFile(join(trainingDir, 'manifest.json'), 'utf-8')
            const manifest = JSON.parse(manifestRaw)
            const filePath = join(trainingDir, 'collected.jsonl')
            let fileSize = 0
            let lineCount = 0
            try {
              const s = await stat(filePath)
              fileSize = s.size
              const content = await readFile(filePath, 'utf-8')
              lineCount = content.trim().split('\n').filter(l => l.trim()).length
            } catch { /* file may not exist yet */ }

            if (jsonOutput) {
              process.stdout.write(JSON.stringify({ ...manifest, fileSize, lineCount, path: filePath }, null, 2) + '\n')
            } else {
              console.log(`\n📦 Training Data Status\n`)
              console.log(`  Collected:       ${manifest.totalCollected} sessions`)
              console.log(`  Skipped:         ${manifest.totalSkipped} sessions`)
              console.log(`  Average quality: ${manifest.averageQuality}/100`)
              console.log(`  Last collected:  ${manifest.lastCollectedAt || 'never'}`)
              console.log(`  File:            ${filePath}`)
              console.log(`  File size:       ${(fileSize / 1024).toFixed(1)} KB`)
              console.log(`  JSONL lines:     ${lineCount}`)
              console.log()
            }
          } catch {
            console.log('\n📦 No training data collected yet.\n')
            console.log(`  Data will be auto-collected to ${trainingDir}/collected.jsonl`)
            console.log(`  when sessions end with quality >= 60\n`)
          }
          process.exit(0)
        }
        case 'clear': {
          try {
            await rm(join(trainingDir, 'collected.jsonl'), { force: true })
            await rm(join(trainingDir, 'manifest.json'), { force: true })
            console.log('Training data cleared.')
          } catch {
            console.log('No training data to clear.')
          }
          process.exit(0)
        }
        case 'path': {
          console.log(join(trainingDir, 'collected.jsonl'))
          process.exit(0)
        }
        case 'scan': {
          // Batch-score all stored sessions and collect those above threshold
          const sessionsDir = join(process.env.OWLCODA_HOME ?? join(process.env.HOME ?? '/tmp', '.owlcoda'), 'sessions')
          const { scoreSession } = await import('./data/quality.js')
          const { collectSession, getCollectorConfig } = await import('./data/collector.js')
          const cfg = getCollectorConfig()
          let files: string[]
          try {
            files = (await readdir(sessionsDir)).filter(f => f.endsWith('.json'))
          } catch {
            console.log('No sessions directory found.')
            process.exit(0)
          }
          console.log(`\n🔍 Scanning ${files.length} sessions (threshold: ${cfg.minQuality})...\n`)
          let collected = 0
          let skipped = 0
          let errors = 0
          const scores: Array<{ file: string; score: number; msgs: number; result: string }> = []
          for (const f of files) {
            try {
              const raw = await readFile(join(sessionsDir, f), 'utf-8')
              const session = JSON.parse(raw)
              const quality = scoreSession(session)
              const msgCount = session.messages?.length ?? 0
              if (quality.overall >= cfg.minQuality && msgCount >= cfg.minMessages) {
                const result = await collectSession(session)
                if (result.collected) {
                  collected++
                  scores.push({ file: f, score: quality.overall, msgs: msgCount, result: '✅ collected' })
                } else {
                  skipped++
                  scores.push({ file: f, score: quality.overall, msgs: msgCount, result: `⏭️ ${result.reason}` })
                }
              } else {
                skipped++
                scores.push({ file: f, score: quality.overall, msgs: msgCount, result: `⏭️ score ${quality.overall} < ${cfg.minQuality}` })
              }
            } catch {
              errors++
            }
          }
          // Show top scoring sessions
          scores.sort((a, b) => b.score - a.score)
          for (const s of scores.slice(0, 15)) {
            console.log(`  ${s.result.padEnd(30)} ${s.file} (score: ${s.score}, msgs: ${s.msgs})`)
          }
          if (scores.length > 15) console.log(`  ... and ${scores.length - 15} more`)
          console.log(`\n  📊 Scanned: ${files.length} | Collected: ${collected} | Skipped: ${skipped} | Errors: ${errors}\n`)
          process.exit(0)
        }
        case 'report': {
          const sessionsDir = join(process.env.OWLCODA_HOME ?? join(process.env.HOME ?? '/tmp', '.owlcoda'), 'sessions')
          const { scoreSession, aggregateQualityReport } = await import('./data/quality.js')
          let files: string[]
          try {
            files = (await readdir(sessionsDir)).filter(f => f.endsWith('.json'))
          } catch {
            console.log('No sessions directory found.')
            process.exit(0)
          }
          const allScores = []
          for (const f of files) {
            try {
              const raw = await readFile(join(sessionsDir, f), 'utf-8')
              const session = JSON.parse(raw)
              if (session.messages?.length >= 2) {
                allScores.push(scoreSession(session))
              }
            } catch { /* skip */ }
          }
          const report = aggregateQualityReport(allScores)
          if (jsonOutput) {
            process.stdout.write(JSON.stringify(report, null, 2) + '\n')
          } else {
            console.log(`\n📊 Training Quality Report (${report.totalSessions} sessions with 2+ messages)\n`)
            console.log(`  Average quality:  ${report.averageQuality}/100`)
            console.log(`  Median quality:   ${report.medianQuality}/100`)
            console.log(`  Distribution:     🟢 ${report.distribution.excellent} excellent  🟡 ${report.distribution.good} good  🟠 ${report.distribution.fair} fair  🔴 ${report.distribution.poor} poor`)
            console.log()
            console.log(`  Dimensions (avg):`)
            console.log(`    Coherence:       ${(report.averageDimensions.coherence * 100).toFixed(0)}%`)
            console.log(`    Informativeness: ${(report.averageDimensions.informativeness * 100).toFixed(0)}%`)
            console.log(`    Tool richness:   ${(report.averageDimensions.toolRichness * 100).toFixed(0)}%`)
            console.log(`    Completeness:    ${(report.averageDimensions.completeness * 100).toFixed(0)}%`)
            console.log(`    Complexity:      ${(report.averageDimensions.complexity * 100).toFixed(0)}%`)
            if (report.topIssues.length > 0) {
              console.log()
              console.log(`  Top issues:`)
              for (const issue of report.topIssues.slice(0, 5)) {
                console.log(`    ${issue.count}× ${issue.issue}`)
              }
            }
            console.log()
          }
          process.exit(0)
        }
        case 'export': {
          // Export training data in various formats
          const { exportTrainingData } = await import('./data/export.js')
          const exportFormat = (passthroughArgs[1] ?? 'jsonl') as 'jsonl' | 'sharegpt' | 'insights'
          if (!['jsonl', 'sharegpt', 'insights'].includes(exportFormat)) {
            console.error(`Unknown format: ${exportFormat}`)
            console.error('Usage: owlcoda training export [jsonl|sharegpt|insights] [--min-quality N] [--sanitize]')
            process.exit(1)
          }
          const minQualityArg = passthroughArgs.includes('--min-quality')
            ? parseInt(passthroughArgs[passthroughArgs.indexOf('--min-quality') + 1] || '0', 10)
            : 0
          const minComplexityArg = passthroughArgs.includes('--min-complexity')
            ? parseInt(passthroughArgs[passthroughArgs.indexOf('--min-complexity') + 1] || '0', 10)
            : 0
          const toolCallsOnly = passthroughArgs.includes('--tool-calls-only')
          const sanitize = passthroughArgs.includes('--sanitize')
          const limitArg = passthroughArgs.includes('--limit')
            ? parseInt(passthroughArgs[passthroughArgs.indexOf('--limit') + 1] || '1000', 10)
            : undefined

          console.error(`Exporting training data (format: ${exportFormat})...`)
          const result = await exportTrainingData({ format: exportFormat, minComplexity: minComplexityArg, minQuality: minQualityArg, toolCallsOnly, limit: limitArg })

          if (sanitize) {
            const { sanitizeText } = await import('./data/sanitize.js')
            for (const line of result.lines) {
              process.stdout.write(sanitizeText(line).text + '\n')
            }
          } else {
            for (const line of result.lines) {
              process.stdout.write(line + '\n')
            }
          }
          console.error(`\nExported ${result.sessionCount} sessions, skipped ${result.skippedCount}`)
          process.exit(0)
        }
        default:
          console.error(`Unknown training subcommand: ${subCmd}`)
          console.error('Usage: owlcoda training [status|scan|report|export|clear|path] [--json]')
          process.exit(1)
      }
      break
    }
    case 'cache': {
      const meta = readRuntimeMeta()
      if (!meta) {
        console.error('owlcoda is not running. Start the proxy first.')
        process.exit(1)
      }
      const baseUrl = getMetaBaseUrl(meta)
      const doClear = passthroughArgs.includes('--clear')
      try {
        if (doClear) {
          const resp = await fetch(`${baseUrl}/v1/cache`, { method: 'DELETE', signal: AbortSignal.timeout(5000) })
          if (!resp.ok) { console.error(`Failed: HTTP ${resp.status}`); process.exit(1) }
          console.error('Cache cleared.')
        } else {
          const resp = await fetch(`${baseUrl}/v1/cache`, { signal: AbortSignal.timeout(5000) })
          if (!resp.ok) { console.error(`Failed: HTTP ${resp.status}`); process.exit(1) }
          const stats = await resp.json() as Record<string, unknown>
          if (jsonOutput) {
            process.stdout.write(JSON.stringify(stats, null, 2) + '\n')
          } else {
            console.error('Response Cache Stats:')
            console.error(`  Entries:   ${stats.size} / ${stats.maxEntries}`)
            console.error(`  TTL:       ${Number(stats.ttlMs) / 1000}s`)
            console.error(`  Enabled:   ${stats.enabled}`)
            console.error(`  Hits:      ${stats.totalHits}`)
            console.error(`  Misses:    ${stats.totalMisses}`)
            console.error(`  Hit rate:  ${(Number(stats.hitRate) * 100).toFixed(1)}%`)
          }
        }
      } catch (err) {
        console.error(`Cannot reach proxy at ${baseUrl}: ${err instanceof Error ? err.message : err}`)
        process.exit(1)
      }
      process.exit(0)
    }
    case 'completions': {
      const shell = passthroughArgs[0] as 'bash' | 'zsh' | 'fish' | undefined
      if (!shell || !['bash', 'zsh', 'fish'].includes(shell)) {
        console.error('Usage: owlcoda completions <bash|zsh|fish>')
        console.error('')
        console.error('Add to your shell config:')
        console.error('  Bash:  eval "$(owlcoda completions bash)"')
        console.error('  Zsh:   eval "$(owlcoda completions zsh)"')
        console.error('  Fish:  owlcoda completions fish | source')
        process.exit(1)
      }
      const { generateCompletion } = await import('./completions.js')
      process.stdout.write(generateCompletion(shell))
      process.exit(0)
    }
    case 'run': {
      const debugRun = isOwlcodaRunDebugEnabled()
      const config = loadEffectiveConfig(configPath, port, routerUrl)
      if (debugRun) console.error('[owlcoda run] loaded config')

      // Read from stdin if no --prompt and stdin is piped
      let effectivePrompt = prompt
      if (!effectivePrompt && !process.stdin.isTTY) {
        if (debugRun) console.error('[owlcoda run] reading stdin prompt')
        const chunks: Buffer[] = []
        for await (const chunk of process.stdin) {
          chunks.push(chunk as Buffer)
        }
        effectivePrompt = Buffer.concat(chunks).toString('utf-8').trim()
      }
      if (!effectivePrompt) {
        console.error('Error: owlcoda run requires --prompt or piped stdin')
        process.exit(1)
      }

      if (debugRun) console.error('[owlcoda run] using native headless mode')

      const defaultModelConf = getPreferredInteractiveConfiguredModel(config)
      const selectedModel = model ?? defaultModelConf?.id ?? 'default'
      const selectedModelConf = config.models?.find(m => m.id === selectedModel || m.aliases?.includes(selectedModel))
      const isCloudDirect = selectedModelConf?.endpoint != null

      if (!isCloudDirect) {
        const preflight = await runPreflight(config)
        if (!preflight.canProceed) {
          const cloudFallback = config.models?.find(m => m.endpoint != null && m.id !== selectedModel)
          if (cloudFallback) {
            console.error(`⚠ Local model "${selectedModel}" unavailable — falling back to cloud model "${cloudFallback.id}"`)
            await ensureProxyRunning(config, configPath, port, routerUrl)
            const runtimeMeta = readRuntimeMeta()
            const effectiveResumeSession = runtimeMeta
              ? resolveResumeSessionTarget(resumeSession, runtimeMeta, 'run')
              : resumeSession
            const { runHeadless } = await import('./native/headless.js')
            const result = await runHeadless({
              apiBaseUrl: getBaseUrl(config),
              apiKey: `owlcoda-local-key-${config.port}`,
              model: cloudFallback.id,
              prompt: effectivePrompt,
              json: jsonOutput,
              autoApprove,
              resumeSession: effectiveResumeSession,
            })
            process.exit(result.exitCode)
          }
          console.error(formatPreflightForCli(preflight))
          console.error(`\nTip: Use --model <cloud-model> to specify a cloud model, or start your local backend first.`)
          process.exit(1)
        }
      }

      await ensureProxyRunning(config, configPath, port, routerUrl)
      const baseUrl = getBaseUrl(config)
      const apiKey = `owlcoda-local-key-${config.port}`
      const runtimeMeta = readRuntimeMeta()
      const effectiveResumeSession = runtimeMeta
        ? resolveResumeSessionTarget(resumeSession, runtimeMeta, 'run')
        : resumeSession

      const { runHeadless } = await import('./native/headless.js')
      const result = await runHeadless({
        apiBaseUrl: baseUrl,
        apiKey,
        model: selectedModel,
        prompt: effectivePrompt,
        json: jsonOutput,
        autoApprove,
        resumeSession: effectiveResumeSession,
        saveSessionOnComplete: true,
      })
      if (debugRun) console.error('[owlcoda run] native headless completed')
      process.exit(result.exitCode)
    }
    case 'launch': {
      if (dryRun) {
        // --dry-run: validate everything without launching
        const { getConfigDisplay, formatConfigDisplay } = await import('./config-display.js')
        const { runDoctor, formatDoctorReport } = await import('./doctor.js')
        const { runValidation, formatValidationResult } = await import('./validate.js')

        // 1. Config display
        const display = getConfigDisplay(configPath)
        console.error(formatConfigDisplay(display))
        console.error('')

        // 2. Config validation
        const validation = runValidation(configPath)
        console.error(formatValidationResult(validation))
        console.error('')

        // 3. Port availability
        const { checkPorts } = await import('./port-utils.js')
        if (validation.raw && typeof validation.raw['port'] === 'number' && typeof validation.raw['routerUrl'] === 'string') {
          const ports = await checkPorts({ port: validation.raw['port'] as number, routerUrl: validation.raw['routerUrl'] as string })
          console.error('Port check:')
          console.error(`  Proxy port ${ports.proxyPort}: ${ports.proxyAvailable ? '✅ available' : '⚠️  in use'}`)
          if (ports.routerPort !== null) {
            console.error(`  Local runtime port ${ports.routerPort}: ${ports.routerAvailable ? '✅ reachable' : '⚠️  not responding'}`)
          }
          console.error('')
        }

        // 4. Doctor checks
        const report = await runDoctor(configPath)
        console.error(formatDoctorReport(report))

        const hasValidationErrors = validation.issues.some(i => i.level === 'error')
        if (report.failCount > 0 || hasValidationErrors) {
          console.error('\n🚫 Dry run: would NOT launch (failed checks above)')
          process.exit(1)
        } else {
          console.error('\n✅ Dry run: everything looks good, ready to launch')
          process.exit(0)
        }
      } else if (daemonOnly) {
        await doStart(configPath, port, routerUrl)
      } else {
        await doLaunch(configPath, port, routerUrl, resumeSession, model)
      }
      break
    }
  }
}
