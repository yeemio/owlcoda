/**
 * owlcoda doctor — diagnostic command that validates the local environment.
 * Checks native runtime readiness and local platform health.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { get as httpGet } from 'node:http'
import { loadConfig, type OwlCodaConfig } from './config.js'
import { assessReplacementReadiness, type ReplacementReadiness } from './replacement-readiness.js'
import { BUILD_INFO, VERSION } from './version.js'
import { validateSemantics } from './config-semantic.js'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getTranscriptInteractionCapability } from './native/repl-compat.js'
import { ModelTruthAggregator, type ModelTruthSnapshot, type ModelStatus } from './model-truth.js'
import { findFlagDebt, GATE_REGISTRY } from './native/gate-registry.js'

export interface CheckResult {
  name: string
  status: 'pass' | 'warn' | 'fail' | 'skip'
  detail: string
}

export interface DoctorReport {
  checks: CheckResult[]
  passCount: number
  warnCount: number
  failCount: number
  skipCount: number
  replacement: ReplacementReadiness
  releaseIdentity: DoctorReleaseIdentity
}

export interface DoctorReleaseIdentity {
  packageVersion: string
  build: { sha: string; dirty: boolean; builtAt: string }
  schemaBundle: {
    algorithm: 'sha256'
    hash: string
    fileCount: number
    files: string[]
  }
}

function check(name: string, status: CheckResult['status'], detail: string): CheckResult {
  return { name, status, detail }
}

// ─── Individual checks ───

/**
 * Flag-debt: opt-in gates whose cutover-or-kill review date has passed. Warns
 * (never fails — debt is a prompt to decide, not an environment fault). Pure
 * over an injected `nowMs` so it is deterministic in tests.
 */
export function checkGateFlagDebt(nowMs: number = Date.now()): CheckResult {
  const debt = findFlagDebt(GATE_REGISTRY, nowMs)
  if (debt.length === 0) {
    return check('Gate flag-debt', 'pass', 'no opt-in gate past its review date')
  }
  const detail = debt
    .map(d => `${d.id} (${d.envVar}) ${d.overdueDays}d overdue → decide: cutover or kill`)
    .join('; ')
  return check('Gate flag-debt', 'warn', detail)
}

function checkNodeVersion(): CheckResult {
  const ver = process.version
  const major = parseInt(ver.slice(1), 10)
  if (major >= 20) return check('Node.js', 'pass', `${ver} (>= v18 required, v20+ recommended)`)
  if (major >= 18) return check('Node.js', 'warn', `${ver} — supported, but v20+ recommended`)
  return check('Node.js', 'fail', `${ver} — requires v18+, recommend v20+`)
}

function checkTsx(): CheckResult {
  try {
    const raw = execFileSync('npx', ['tsx', '--version'], { stdio: 'pipe', timeout: 10000 }).toString().trim()
    // `npx tsx --version` emits two lines: "tsx vX.Y.Z\nnode vA.B.C".
    // Keep only the tsx line so the doctor row stays single-line and aligned.
    const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? ''
    // Extract a vX.Y.Z token regardless of leading "tsx " / "v" prefix.
    const match = firstLine.match(/v?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/)
    const version = match ? `v${match[1]}` : firstLine || 'installed'
    return check('tsx runtime', 'pass', version)
  } catch {
    return check('tsx runtime', 'warn', 'not found — required only for local TypeScript dev workflows')
  }
}

function checkConfig(configPath?: string): { result: CheckResult; config: OwlCodaConfig | null } {
  try {
    const config = loadConfig(configPath)
    const modelCount = config.models?.length ?? 0
    return {
      result: check('Config', 'pass', `loaded (${modelCount} model${modelCount === 1 ? '' : 's'} configured)`),
      config,
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      result: check('Config', 'fail', `cannot load — ${msg}`),
      config: null,
    }
  }
}

function httpProbe(url: string, timeoutMs: number = 3000): Promise<{ ok: boolean; statusCode?: number; timeMs: number }> {
  const start = Date.now()
  return new Promise(resolve => {
    const req = httpGet(url, { timeout: timeoutMs }, res => {
      res.resume()
      resolve({ ok: (res.statusCode ?? 0) < 500, statusCode: res.statusCode, timeMs: Date.now() - start })
    })
    req.on('error', () => resolve({ ok: false, timeMs: Date.now() - start }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, timeMs: Date.now() - start }) })
  })
}

async function readModelTruth(config: OwlCodaConfig): Promise<ModelTruthSnapshot> {
  const aggregator = new ModelTruthAggregator(() => config, {
    ttlMs: 5_000,
    routerProbeTimeoutMs: 3_000,
    discoveryTimeoutMs: 3_000,
  })
  return aggregator.getSnapshot({ skipCache: true })
}

function isPlaceholderConfig(config: OwlCodaConfig): boolean {
  // Day-0 sentinel produced by `owlcoda init` when no router responded.
  // Treat router/model failures as warnings (not blockers) in this state so
  // a fresh user isn't told to "fix" something they haven't configured yet.
  const models = config.models ?? []
  return models.length === 0
    || (models.length === 1 && models[0]?.id === 'your-default-model')
}

function checkRouter(config: OwlCodaConfig, snapshot: ModelTruthSnapshot): CheckResult {
  if (!snapshot.runtimeOk) {
    if (isPlaceholderConfig(config)) {
      return check('Local runtime', 'warn',
        `${config.routerUrl} — not reachable. Add a cloud provider in \`owlcoda admin\`, or install a local backend (Ollama / LM Studio / vLLM) and rerun \`owlcoda init\`.`)
    }
    return check('Local runtime', 'fail', `${config.routerUrl} — not reachable (is the local runtime running?)`)
  }

  const rawSource = snapshot.runtimeSource ?? 'runtime'
  // Display label: collapse the legacy `deprecated_router_models` enum to the
  // engineering reality — it IS the OpenAI-compatible /v1/models surface; the
  // "deprecated" tag only refers to the upstream router's secondary
  // /v1/platform/model-visibility contract, not the discovery path itself.
  const displaySource = rawSource === 'deprecated_router_models'
    ? 'openai_compatible_models'
    : rawSource
  const detailSuffix = rawSource === 'runtime_status'
    ? ` (${snapshot.runtimeProbeDetail || `${snapshot.runtimeModelCount} models`})`
    : snapshot.runtimeProbeDetail
      ? ` (${snapshot.runtimeProbeDetail})`
      : ''

  if (rawSource === 'loaded_inventory_only') {
    return check('Local runtime', 'warn', `${config.routerUrl} — ${displaySource}${detailSuffix}`)
  }

  // `deprecated_router_models` reports a healthy /v1/models response — treat
  // it as pass; the legacy visibility surface is informational only.
  return check('Local runtime', 'pass', `${config.routerUrl} — ${displaySource}${detailSuffix}`)
}

function formatModelIssue(status: ModelStatus): string {
  switch (status.availability.kind) {
    case 'missing_key':
      return status.availability.envName ? `${status.id}: missing key (${status.availability.envName})` : `${status.id}: missing key`
    case 'router_missing':
      return `${status.id}: ${status.availability.reason ?? 'not visible in runtime truth'}`
    case 'orphan_discovered':
      return `${status.id}: discovered but not configured`
    case 'alias_conflict':
      return `${status.id}: alias conflict (${status.availability.with})`
    case 'endpoint_down':
      return `${status.id}: endpoint down`
    case 'warming':
      return `${status.id}: warming`
    case 'unknown':
      return `${status.id}: ${status.availability.reason}`
    case 'ok':
      return status.id
  }
}

function checkModels(snapshot: ModelTruthSnapshot, config: OwlCodaConfig): CheckResult {
  const configured = snapshot.statuses.filter(status => status.presentIn.config)
  if (configured.length === 0) {
    return check('Models', 'warn', 'no configured models')
  }

  const healthy = configured.filter(status => status.availability.kind === 'ok')
  const issues = configured.filter(status => status.availability.kind !== 'ok')

  if (issues.length === 0) {
    return check('Models', 'pass', `${healthy.length} configured model${healthy.length === 1 ? '' : 's'} healthy`)
  }

  const samples = issues.slice(0, 3).map(formatModelIssue).join('; ')
  // Day-0 placeholder config: don't escalate "0 healthy" to fail — the user
  // simply hasn't picked a model yet. Router check already carries the
  // actionable guidance.
  const dayZero = isPlaceholderConfig(config) && healthy.length === 0
  const level: CheckResult['status'] = healthy.length > 0 || dayZero ? 'warn' : 'fail'
  return check(
    'Models',
    level,
    `${healthy.length}/${configured.length} healthy${samples ? ` — ${samples}${issues.length > 3 ? ` +${issues.length - 3} more` : ''}` : ''}`,
  )
}

async function checkProxy(config: OwlCodaConfig): Promise<CheckResult> {
  const url = `http://127.0.0.1:${config.port}/healthz`
  const probe = await httpProbe(url)
  if (probe.ok) {
    return check('OwlCoda proxy', 'pass', `port ${config.port} — responded in ${probe.timeMs}ms`)
  }
  return check('OwlCoda proxy', 'skip', `port ${config.port} — not running (will be started on launch)`)
}

function checkLaunchMode(): CheckResult {
  return check('Launch mode', 'pass', 'native (shared daemon, multi-client live REPL control plane)')
}

function checkTranscriptInteraction(): CheckResult {
  const interaction = getTranscriptInteractionCapability()
  const status = interaction.wheelSupport === 'verified' ? 'pass' : 'warn'
  return check(
    'Transcript interaction',
    status,
    `${interaction.selectionSummary} ${interaction.wheelSummary} Environment: ${interaction.environmentLabel}.`,
  )
}

async function checkSearXNG(): Promise<CheckResult> {
  const url = process.env.OWLCODA_SEARXNG_URL || 'http://localhost:8888'
  const probe = await httpProbe(url, 2000)
  if (probe.ok) {
    return check('SearXNG', 'pass', `${url} — responded in ${probe.timeMs}ms`)
  }
  return check('SearXNG', 'warn',
    `${url} — not reachable (optional; the WebSearch tool needs SearXNG, but you can ignore this if you don't use web search)`)
}

async function checkTrainingData(): Promise<CheckResult> {
  const owlcodaHome = process.env.OWLCODA_HOME ?? join(process.env.HOME ?? '/tmp', '.owlcoda')
  const trainingDir = join(owlcodaHome, 'training')
  const collectedPath = join(trainingDir, 'collected.jsonl')
  const manifestPath = join(trainingDir, 'manifest.json')

  try {
    if (!existsSync(trainingDir)) {
      return check('Training data', 'skip', 'no training data directory yet')
    }

    let collected = 0
    let skipped = 0
    let avgQuality = 0
    let sizeKB = 0

    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'))
      collected = manifest.totalCollected ?? 0
      skipped = manifest.totalSkipped ?? 0
      avgQuality = manifest.averageQuality ?? 0
    }

    if (existsSync(collectedPath)) {
      const st = await stat(collectedPath)
      sizeKB = Math.round(st.size / 1024)
    }

    if (collected === 0 && skipped === 0) {
      return check('Training data', 'skip', 'pipeline active but no data collected yet')
    }

    const hitRate = collected + skipped > 0
      ? Math.round((collected / (collected + skipped)) * 100)
      : 0

    return check('Training data', 'pass',
      `${collected} collected, ${skipped} skipped (${hitRate}% hit rate, avg quality ${avgQuality}, ${sizeKB}KB)`)
  } catch {
    return check('Training data', 'warn', 'could not read training data')
  }
}

async function checkSkillsHealth(): Promise<CheckResult> {
  let learnedCount = 0
  try {
    const { loadLearnedSkills } = await import('./skills/store.js')
    learnedCount = (await loadLearnedSkills()).length
  } catch { /* ignore */ }

  let curatedCount = 0
  try {
    const { loadCuratedSkills } = await import('./skills/curated.js')
    curatedCount = (await loadCuratedSkills()).length
  } catch { /* ignore */ }

  const total = learnedCount + curatedCount
  if (total === 0) {
    return check('Skills', 'warn', 'no skills loaded (skill injection will be inactive)')
  }
  return check('Skills', 'pass', `${curatedCount} curated + ${learnedCount} learned = ${total} total`)
}

/** Compare two semver strings. >0 if a>b, <0 if a<b, 0 if equal. Malformed
 *  segments count as 0. (Sufficient for major.minor.patch; ignores pre-release.) */
export function compareSemver(a: string, b: string): number {
  const parse = (s: string) => s.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

let registryVersionCheckCache: CheckResult | null = null

/** Compare installed version against the latest on the configured npm registry.
 *  Warns when the registry is ahead (upgrade available); skips when offline /
 *  npm absent. Surfaces the npm-mirror-lag case where users sat on an old build
 *  without knowing a newer one shipped. */
function computeRegistryVersionCheck(): CheckResult {
  let latest: string
  try {
    latest = execFileSync('npm', ['view', 'owlcoda', 'version'], {
      stdio: 'pipe',
      timeout: 8000,
    }).toString().trim()
  } catch {
    return check('Registry version', 'skip', `installed v${VERSION} (could not reach npm registry — skipped)`)
  }
  if (!/^\d+\.\d+\.\d+/.test(latest)) {
    return check('Registry version', 'skip', `installed v${VERSION} (registry returned unparseable version)`)
  }
  if (compareSemver(latest, VERSION) > 0) {
    return check(
      'Registry version',
      'warn',
      `installed v${VERSION}, registry latest v${latest} — run \`npm install -g owlcoda@latest\`. ` +
        'On a mirror it may lag; try `--registry https://registry.npmjs.org`.',
    )
  }
  return check('Registry version', 'pass', `installed v${VERSION} (up to date with registry v${latest})`)
}

async function checkRegistryVersion(): Promise<CheckResult> {
  if (!registryVersionCheckCache) {
    registryVersionCheckCache = computeRegistryVersionCheck()
  }
  return registryVersionCheckCache
}

// ─── Main doctor entry ───

export async function runDoctor(configPath?: string): Promise<DoctorReport> {
  const checks: CheckResult[] = []

  // Sync checks
  checks.push(checkNodeVersion())
  checks.push(checkTsx())
  checks.push(await checkRegistryVersion())

  const { result: configResult, config } = checkConfig(configPath)
  checks.push(configResult)

  // Async checks (only if config loaded)
  if (config) {
    // Semantic validation
    const semanticWarnings = validateSemantics(config as unknown as Record<string, unknown>)
    for (const sw of semanticWarnings) {
      checks.push(check(
        `Config: ${sw.code}`,
        sw.level === 'error' ? 'fail' : 'warn',
        sw.message,
      ))
    }

    const [snapshot, proxyResult] = await Promise.all([
      readModelTruth(config),
      checkProxy(config),
    ])
    if (snapshot.runtimeOk && snapshot.runtimeLocalProtocol) {
      config.localRuntimeProtocol = snapshot.runtimeLocalProtocol
    }
    const routerResult = checkRouter(config, snapshot)
    const modelsResult = checkModels(snapshot, config)
    checks.push(routerResult)
    checks.push(proxyResult)
    checks.push(modelsResult)
  }

  checks.push(checkLaunchMode())
  checks.push(checkTranscriptInteraction())
  checks.push(checkGateFlagDebt())

  // Data pipeline checks (independent of config)
  const [searxngResult, trainingResult, skillsResult] = await Promise.all([
    checkSearXNG(),
    checkTrainingData(),
    checkSkillsHealth(),
  ])
  checks.push(searxngResult)
  checks.push(skillsResult)
  checks.push(trainingResult)

  const passCount = checks.filter(c => c.status === 'pass').length
  const warnCount = checks.filter(c => c.status === 'warn').length
  const failCount = checks.filter(c => c.status === 'fail').length
  const skipCount = checks.filter(c => c.status === 'skip').length

  return {
    checks,
    passCount,
    warnCount,
    failCount,
    skipCount,
    replacement: assessReplacementReadiness(checks),
    releaseIdentity: await buildDoctorReleaseIdentity(),
  }
}

export async function buildDoctorReleaseIdentity(): Promise<DoctorReleaseIdentity> {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const schemaRoot = join(moduleDir, '..', 'schemas')
  const files = await listFiles(schemaRoot)
  const digest = createHash('sha256')
  for (const file of files) {
    const name = relative(schemaRoot, file).replace(/\\/g, '/')
    digest.update(`${name.length}:${name}\0`)
    digest.update(await readFile(file))
    digest.update('\0')
  }
  return {
    packageVersion: VERSION,
    build: { ...BUILD_INFO },
    schemaBundle: {
      algorithm: 'sha256',
      hash: `sha256:${digest.digest('hex')}`,
      fileCount: files.length,
      files: files.map(file => relative(schemaRoot, file).replace(/\\/g, '/')),
    },
  }
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) out.push(path)
    }
  }
  await walk(root)
  return out.sort()
}

const ICONS: Record<CheckResult['status'], string> = {
  pass: '✅',
  warn: '⚠️',
  fail: '❌',
  skip: '⏭️',
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [
    `\nowlcoda doctor v${VERSION}`,
    '─'.repeat(50),
  ]

  for (const c of report.checks) {
    lines.push(`${ICONS[c.status]}  ${c.name.padEnd(20)} ${c.detail}`)
  }

  lines.push('─'.repeat(50))
  const parts: string[] = []
  if (report.passCount > 0) parts.push(`${report.passCount} passed`)
  if (report.warnCount > 0) parts.push(`${report.warnCount} warnings`)
  if (report.failCount > 0) parts.push(`${report.failCount} failed`)
  if (report.skipCount > 0) parts.push(`${report.skipCount} skipped`)
  lines.push(parts.join(' · '))

  const dayZeroWarn = report.checks.find(c =>
    c.name === 'Local runtime' && c.status === 'warn' && c.detail.includes('not reachable'))

  if (report.failCount === 0) {
    if (dayZeroWarn) {
      lines.push('\n👋 OwlCoda is installed. Next: install a local backend (Ollama / LM Studio / vLLM)')
      lines.push('   then rerun `owlcoda init` to auto-detect models. See README Quickstart.')
    } else {
      lines.push('\n🎉 Environment looks good!')
    }
  } else {
    lines.push('\n🔧 Fix the failed checks above before launching.')
  }

  lines.push('')
  lines.push('Native capabilities:')
  lines.push('  ✓ Native REPL — 42+ tools, 69+ commands')
  lines.push('  ✓ Multi-client live REPL — shared daemon with per-client session affinity')
  lines.push('  ✓ Live client control plane — clients list/detach/force-detach plus runtime-scoped force stop')
  lines.push('  ✓ Session persistence — save, resume, export')
  lines.push('  ✓ Skill system — L2 learning active')
  lines.push('  ✓ Training pipeline — L3 data collection')
  lines.push('  ✓ Multi-backend routing — local + cloud models')

  // Skip the Setup status block on Day-0 placeholder configs — the friendly
  // "👋 OwlCoda is installed" line above already carries the right next-step
  // guidance, and the readiness blockers (e.g. "deprecated fallback") are
  // not accurate when the router is simply unreachable.
  if (!dayZeroWarn) {
    lines.push('')
    lines.push('Setup status:')
    if (report.replacement.strengths?.length > 0) {
      for (const s of report.replacement.strengths) {
        lines.push(`  ✓ ${s}`)
      }
    }
    for (const blocker of report.replacement.blockers) {
      lines.push(`  ✗ ${blocker}`)
    }
  }

  return lines.join('\n')
}
