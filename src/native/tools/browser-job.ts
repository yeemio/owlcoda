import { execFile } from 'node:child_process'
import { constants, existsSync } from 'node:fs'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  addJobArtifacts,
  appendJobOutput,
  createJob,
  finishJob,
  getJob,
  registerJobAbortAdapter,
  recordJobCleanup,
  startJob,
  unregisterJobAbortAdapter,
  type JobArtifactRef,
  type JobRecord,
} from '../job-supervisor.js'
import { getRunWorkspacePathsFromRef, recordArtifact } from '../run-workspace.js'
import { htmlToText } from './web-fetch.js'
import type { NativeToolDef, ToolExecutionContext, ToolResult } from './types.js'

export interface BrowserJobInput {
  url: string
  provider?: string
  chromeExecutablePath?: string
  waitForSelector?: string
  artifactDir?: string
  cwd?: string
  deadlineMs?: number
  runRef?: string
  environment?: string
  project?: string
  origin?: string
  stepId?: string
  participatesInFinal?: boolean
}

const DEFAULT_DEADLINE_MS = 30_000
const MAX_DEADLINE_MS = 120_000
const FETCH_HTML_PROVIDER = 'fetch_html'
const CHROME_HEADLESS_PROVIDER = 'chrome_headless'
const SUPPORTED_PROVIDERS = new Set([FETCH_HTML_PROVIDER, CHROME_HEADLESS_PROVIDER])

export function createBrowserJobTool(): NativeToolDef<BrowserJobInput> {
  return {
    name: 'BrowserJob',
    description:
      'Run a platform-supervised browser-style capture job for one HTTP(S) URL. ' +
      'The v1 provider is fetch_html: it captures HTML/text artifacts, checks simple selectors, and records timeout/failure state in Job supervisor.',
    maturity: 'beta',

    async execute(input: BrowserJobInput, context?: ToolExecutionContext): Promise<ToolResult> {
      const validation = validateInput(input)
      if (validation) return validation

      const cwd = input.cwd && input.cwd.trim() ? resolve(input.cwd) : process.cwd()
      const deadlineMs = clampDeadline(input.deadlineMs)
      const provider = input.provider?.trim() || FETCH_HTML_PROVIDER
      const parsed = new URL(input.url)
      const created = createJob({
        type: 'browser',
        stage: 'queued',
        cwd,
        tool: 'BrowserJob',
        provider,
        command: `GET ${parsed.href}`,
        deadlineMs,
        recoveryHint: 'JobList type=browser or JobGet jobId=<jobId>',
      })
      const jobId = created.jobId
      startJob(jobId, {
        stage: provider === CHROME_HEADLESS_PROVIDER ? 'launching' : 'fetching',
        externalHandle: parsed.href,
      })
      const liveCancelController = new AbortController()
      registerJobAbortAdapter(jobId, (reason) => {
        liveCancelController.abort(new Error(`JobCancel: ${reason}`))
      })

      try {
        if (provider === CHROME_HEADLESS_PROVIDER) {
          return await runChromeHeadlessJob({
            input,
            jobId,
            parsed,
            cwd,
            deadlineMs,
            context,
            liveCancelSignal: liveCancelController.signal,
          })
        }

        const signal = composeAbortSignal(deadlineMs, context?.signal, liveCancelController.signal)
        const res = await fetch(parsed.href, {
          signal,
          redirect: 'follow',
          headers: {
            'User-Agent': 'OwlCoda/0.5.0 (browser-job fetch_html)',
            Accept: 'text/html, application/xhtml+xml, text/plain, */*',
          },
        })

        if (!res.ok) {
          const message = `HTTP ${res.status} ${res.statusText} fetching ${parsed.href}`
          appendJobOutput(jobId, `${message}\n`)
          finishJob(jobId, 'failed', {
            stage: 'http_error',
            error: message,
            terminationReason: 'http_error',
          })
          recordFetchCleanup(jobId)
          return browserResult(jobId, true, `Browser job failed: ${message}`)
        }

        const html = await res.text()
        appendJobOutput(jobId, `Fetched ${parsed.href} status=${res.status} bytes=${html.length}\n`)

        const artifacts = await writeBrowserArtifacts({
          jobId,
          artifactDir: resolveBrowserArtifactDir(input, cwd),
          cwd,
          html,
          text: htmlToText(html),
        })
        const recordedArtifacts = await recordBrowserArtifacts({
          artifacts,
          input,
          jobId,
          cwd,
        })
        addJobArtifacts(jobId, recordedArtifacts)
        appendJobOutput(jobId, `Saved ${artifacts.length} artifact(s)\n`)

        if (input.waitForSelector && !selectorExists(html, input.waitForSelector)) {
          const message = `selector not found: ${input.waitForSelector}`
          const hint =
            'fetch_html captures static HTML only; for client-rendered selectors use provider=chrome_headless or inspect saved browser_html/browser_text artifacts.'
          appendJobOutput(jobId, `${message}\n${hint}\n`)
          finishJob(jobId, 'failed', {
            stage: 'selector_missing',
            error: message,
            terminationReason: 'selector_missing',
          })
          recordFetchCleanup(jobId)
          return browserResult(jobId, true, `Browser job failed: ${message}\n${hint}`)
        }

        finishJob(jobId, 'done', { stage: 'completed' })
        recordFetchCleanup(jobId)
        const selectorNote = input.waitForSelector ? ` selector=${input.waitForSelector}` : ''
        return browserResult(jobId, false, `Browser job completed: ${jobId}${selectorNote}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const timedOut = isAbortLikeError(err)
        appendJobOutput(jobId, `${message}\n`)
        if (getJob(jobId)?.status === 'cancelled') {
          recordFetchCleanup(jobId)
          return browserResult(jobId, true, `Browser job cancelled: ${jobId}`)
        }
        finishJob(jobId, timedOut ? 'timeout' : 'failed', {
          stage: timedOut ? 'timeout' : 'failed',
          error: timedOut ? `request timed out after ${deadlineMs}ms` : message,
          terminationReason: timedOut ? 'deadline_exceeded' : 'execution_error',
        })
        recordFetchCleanup(jobId)
        const failureHint = !timedOut ? browserFetchFailureHint(parsed) : ''
        return browserResult(
          jobId,
          true,
          timedOut
            ? `Browser job timed out after ${deadlineMs}ms: ${jobId}`
            : `Browser job failed: ${message}${failureHint ? `\n${failureHint}` : ''}`,
          !timedOut
            ? {
                failureCategory: 'browser-job:fetch-failed',
                recoverable: true,
              }
            : undefined,
        )
      } finally {
        unregisterJobAbortAdapter(jobId)
      }
    },
  }
}

function validateInput(input: BrowserJobInput): ToolResult | null {
  if (!input || typeof input.url !== 'string' || !input.url.trim()) {
    return { output: 'Error: url is required.', isError: true }
  }
  let parsed: URL
  try {
    parsed = new URL(input.url)
  } catch {
    return { output: `Error: invalid URL "${input.url}".`, isError: true }
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { output: `Error: only HTTP/HTTPS URLs are supported (got ${parsed.protocol}).`, isError: true }
  }
  if (input.waitForSelector !== undefined && (typeof input.waitForSelector !== 'string' || !input.waitForSelector.trim())) {
    return { output: 'Error: waitForSelector must be a non-empty string when provided.', isError: true }
  }
  if (input.provider !== undefined && !SUPPORTED_PROVIDERS.has(input.provider.trim())) {
    return {
      output: `Error: unsupported BrowserJob provider "${input.provider}". Supported providers: ${[...SUPPORTED_PROVIDERS].join(', ')}.`,
      isError: true,
      metadata: { failureCategory: 'browser-job:unsupported-provider' },
    }
  }
  if (input.chromeExecutablePath !== undefined && (typeof input.chromeExecutablePath !== 'string' || !input.chromeExecutablePath.trim())) {
    return { output: 'Error: chromeExecutablePath must be a non-empty string when provided.', isError: true }
  }
  if (input.artifactDir !== undefined && (typeof input.artifactDir !== 'string' || !input.artifactDir.trim())) {
    return { output: 'Error: artifactDir must be a non-empty string when provided.', isError: true }
  }
  if (input.runRef !== undefined && (typeof input.runRef !== 'string' || !input.runRef.trim())) {
    return { output: 'Error: runRef must be a non-empty string when provided.', isError: true }
  }
  return null
}

async function runChromeHeadlessJob(args: {
  input: BrowserJobInput
  jobId: string
  parsed: URL
  cwd: string
  deadlineMs: number
  context?: ToolExecutionContext
  liveCancelSignal: AbortSignal
}): Promise<ToolResult> {
  const executable = await resolveChromeExecutable(args.input.chromeExecutablePath)
  if (!executable) {
    const message = 'chrome_headless provider is not configured: set chromeExecutablePath or install Chrome/Chromium.'
    appendJobOutput(args.jobId, `${message}\n`)
    finishJob(args.jobId, 'failed', {
      stage: 'provider_not_configured',
      error: message,
      terminationReason: 'provider_not_configured',
    })
    recordJobCleanup(args.jobId, {
      attempted: false,
      succeeded: false,
      remainingPids: [],
    })
    return browserResult(args.jobId, true, `Browser job failed: ${message}`)
  }

  const artifactRoot = resolve(args.cwd, resolveBrowserArtifactDir(args.input, args.cwd)?.trim() || '.owlcoda-browser-jobs')
  const dir = resolve(artifactRoot, sanitizePathSegment(args.jobId))
  const profileDir = resolve(dir, 'chrome-profile')
  const screenshotPath = resolve(dir, 'screenshot.png')
  const domPath = resolve(dir, 'dom.html')
  const textPath = resolve(dir, 'text.txt')
  await mkdir(profileDir, { recursive: true })
  appendJobOutput(args.jobId, `Launching chrome_headless executable=${executable}\n`)

  try {
    startJob(args.jobId, { stage: 'capturing', externalHandle: executable })
    const signal = composeAbortSignal(args.deadlineMs, args.context?.signal, args.liveCancelSignal)
    const { stdout, stderr } = await execFileText(executable, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profileDir}`,
      '--window-size=1280,900',
      `--screenshot=${screenshotPath}`,
      '--dump-dom',
      args.parsed.href,
    ], {
      timeoutMs: args.deadlineMs,
      signal,
    })
    if (stderr.trim()) appendJobOutput(args.jobId, stderr.slice(-2000))
    const html = stdout.trim()
    appendJobOutput(args.jobId, `Chrome captured ${args.parsed.href} dom_bytes=${html.length}\n`)

    await writeFile(domPath, html, 'utf-8')
    await writeFile(textPath, htmlToText(html), 'utf-8')
    const artifacts = [
      { path: screenshotPath, artifactType: 'browser_screenshot' },
      { path: domPath, artifactType: 'browser_dom' },
      { path: textPath, artifactType: 'browser_text' },
    ]
    const recordedArtifacts = await recordBrowserArtifacts({
      artifacts,
      input: args.input,
      jobId: args.jobId,
      cwd: args.cwd,
    })
    addJobArtifacts(args.jobId, recordedArtifacts)
    appendJobOutput(args.jobId, `Saved ${artifacts.length} chrome_headless artifact(s)\n`)

    if (args.input.waitForSelector && !selectorExists(html, args.input.waitForSelector)) {
      const message = `selector not found: ${args.input.waitForSelector}`
      appendJobOutput(args.jobId, `${message}\n`)
      finishJob(args.jobId, 'failed', {
        stage: 'selector_missing',
        error: message,
        terminationReason: 'selector_missing',
      })
      await cleanupChromeProfile(args.jobId, profileDir)
      return browserResult(args.jobId, true, `Browser job failed: ${message}`)
    }

    finishJob(args.jobId, 'done', { stage: 'completed' })
    await cleanupChromeProfile(args.jobId, profileDir)
    const selectorNote = args.input.waitForSelector ? ` selector=${args.input.waitForSelector}` : ''
    return browserResult(args.jobId, false, `Browser job completed: ${args.jobId}${selectorNote}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const timedOut = isAbortLikeError(err) || isExecTimeoutError(err)
    const partialOutput = extractExecFilePartialOutput(err)
    appendJobOutput(args.jobId, `${message}\n`)
    if (partialOutput.stderr.trim()) appendJobOutput(args.jobId, partialOutput.stderr.slice(-2000))
    if (getJob(args.jobId)?.status === 'cancelled') {
      await cleanupChromeProfile(args.jobId, profileDir)
      return browserResult(args.jobId, true, `Browser job cancelled: ${args.jobId}`)
    }
    if (timedOut) {
      await recordPartialChromeArtifacts({
        jobId: args.jobId,
        input: args.input,
        cwd: args.cwd,
        screenshotPath,
        domPath,
        textPath,
        html: partialOutput.stdout.trim(),
      })
    }
    finishJob(args.jobId, timedOut ? 'timeout' : 'failed', {
      stage: timedOut ? 'timeout' : 'failed',
      error: timedOut ? `chrome_headless timed out after ${args.deadlineMs}ms` : message,
      terminationReason: timedOut ? 'deadline_exceeded' : 'execution_error',
    })
    await cleanupChromeProfile(args.jobId, profileDir)
    return browserResult(
      args.jobId,
      true,
      timedOut
        ? `Browser job timed out after ${args.deadlineMs}ms: ${args.jobId}`
        : `Browser job failed: ${message}`,
    )
  }
}

function execFileText(
  file: string,
  args: string[],
  options: { timeoutMs: number; signal: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, {
      encoding: 'utf8',
      timeout: options.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      signal: options.signal,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, {
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        }))
      }
      else resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

function extractExecFilePartialOutput(err: unknown): { stdout: string; stderr: string } {
  if (!err || typeof err !== 'object') return { stdout: '', stderr: '' }
  const record = err as Record<string, unknown>
  return {
    stdout: typeof record['stdout'] === 'string' ? record['stdout'] : '',
    stderr: typeof record['stderr'] === 'string' ? record['stderr'] : '',
  }
}

async function recordPartialChromeArtifacts(args: {
  jobId: string
  input: BrowserJobInput
  cwd: string
  screenshotPath: string
  domPath: string
  textPath: string
  html: string
}): Promise<void> {
  const artifacts: Array<{ path: string; artifactType: string }> = []
  if (existsSync(args.screenshotPath)) {
    artifacts.push({ path: args.screenshotPath, artifactType: 'browser_screenshot' })
  }
  if (args.html) {
    await writeFile(args.domPath, args.html, 'utf-8')
    await writeFile(args.textPath, htmlToText(args.html), 'utf-8')
    artifacts.push(
      { path: args.domPath, artifactType: 'browser_dom' },
      { path: args.textPath, artifactType: 'browser_text' },
    )
  }
  if (artifacts.length === 0) return
  const recordedArtifacts = await recordBrowserArtifacts({
    artifacts,
    input: args.input,
    jobId: args.jobId,
    cwd: args.cwd,
  })
  addJobArtifacts(args.jobId, recordedArtifacts)
  appendJobOutput(args.jobId, `Saved ${artifacts.length} partial chrome_headless artifact(s)\n`)
}

async function resolveChromeExecutable(explicitPath?: string): Promise<string | undefined> {
  if (explicitPath?.trim()) {
    const resolved = resolve(explicitPath)
    return await isExecutable(resolved) ? resolved : undefined
  }
  for (const candidate of chromeExecutableCandidates()) {
    if (await isExecutable(candidate)) return candidate
  }
  return undefined
}

function chromeExecutableCandidates(): string[] {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    ]
  }
  if (process.platform === 'win32') {
    const programFiles = [
      process.env['PROGRAMFILES'],
      process.env['PROGRAMFILES(X86)'],
      process.env['LOCALAPPDATA'],
    ].filter((value): value is string => Boolean(value))
    return programFiles.flatMap(root => [
      resolve(root, 'Google/Chrome/Application/chrome.exe'),
      resolve(root, 'Chromium/Application/chrome.exe'),
      resolve(root, 'Microsoft/Edge/Application/msedge.exe'),
    ])
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ]
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function cleanupChromeProfile(jobId: string, profileDir: string): Promise<void> {
  try {
    await rm(profileDir, { recursive: true, force: true })
    recordJobCleanup(jobId, {
      attempted: true,
      succeeded: true,
      remainingPids: [],
    })
  } catch {
    recordJobCleanup(jobId, {
      attempted: true,
      succeeded: false,
      remainingPids: [],
    })
  }
}

function clampDeadline(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_DEADLINE_MS
  return Math.min(Math.floor(value), MAX_DEADLINE_MS)
}

function composeAbortSignal(deadlineMs: number, ...signals: Array<AbortSignal | undefined>): AbortSignal {
  const timeout = AbortSignal.timeout(deadlineMs)
  const activeSignals = [timeout, ...signals.filter((signal): signal is AbortSignal => Boolean(signal))]
  return activeSignals.length === 1 ? timeout : AbortSignal.any(activeSignals)
}

function isAbortLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.name === 'AbortError' || err.name === 'TimeoutError' || /abort|timeout/i.test(err.message)
}

function isExecTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const record = err as Record<string, unknown>
  return record['killed'] === true
    || record['code'] === 'ETIMEDOUT'
    || record['signal'] === 'SIGTERM'
}

async function writeBrowserArtifacts(args: {
  jobId: string
  artifactDir?: string
  cwd: string
  html: string
  text: string
}): Promise<Array<{ path: string; artifactType: string }>> {
  const root = resolve(args.cwd, args.artifactDir?.trim() || '.owlcoda-browser-jobs')
  const dir = resolve(root, sanitizePathSegment(args.jobId))
  await mkdir(dir, { recursive: true })
  const htmlPath = resolve(dir, 'page.html')
  const textPath = resolve(dir, 'text.txt')
  await writeFile(htmlPath, args.html, 'utf-8')
  await writeFile(textPath, args.text, 'utf-8')
  return [
    { path: htmlPath, artifactType: 'browser_html' },
    { path: textPath, artifactType: 'browser_text' },
  ]
}

function resolveBrowserArtifactDir(input: BrowserJobInput, cwd: string): string | undefined {
  if (input.artifactDir?.trim()) return input.artifactDir
  if (!input.runRef?.trim()) return undefined
  const paths = getRunWorkspacePathsFromRef(input.runRef, cwd)
  return join(paths.evidenceDir, 'browser')
}

async function recordBrowserArtifacts(args: {
  artifacts: Array<{ path: string; artifactType: string }>
  input: BrowserJobInput
  jobId: string
  cwd: string
}): Promise<Array<{ id?: string; path: string; artifactType: string }>> {
  if (!args.input.runRef?.trim()) return args.artifacts

  const recorded = []
  for (const artifact of args.artifacts) {
    const record = await recordArtifact(args.input.runRef, {
      path: artifact.path,
      origin: args.input.origin?.trim() || 'browser_job',
      ...(args.input.environment?.trim() ? { environment: args.input.environment } : {}),
      ...(args.input.project?.trim() ? { project: args.input.project } : {}),
      jobId: args.jobId,
      artifactType: artifact.artifactType,
      ...(args.input.stepId?.trim() ? { stepId: args.input.stepId } : {}),
      ...(typeof args.input.participatesInFinal === 'boolean' ? { participatesInFinal: args.input.participatesInFinal } : {}),
    }, args.cwd)
    recorded.push({
      id: record.id,
      path: record.path,
      artifactType: record.artifactType ?? artifact.artifactType,
    })
  }
  return recorded
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_')
}

function selectorExists(html: string, selector: string): boolean {
  const trimmed = selector.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('#')) return attributeTokenExists(html, 'id', trimmed.slice(1))
  if (trimmed.startsWith('.')) return attributeTokenExists(html, 'class', trimmed.slice(1))
  if (/^[A-Za-z][A-Za-z0-9:-]*$/.test(trimmed)) {
    return new RegExp(`<\\s*${escapeRegExp(trimmed)}(?:\\s|>|/)`, 'i').test(html)
  }
  const attrMatch = trimmed.match(/^\[([A-Za-z_:][-A-Za-z0-9_:.]*)(?:=(["']?)([^"'\]]+)\2)?]$/)
  if (attrMatch) {
    const [, attr, , value] = attrMatch
    if (value === undefined) return new RegExp(`<[^>]+\\s${escapeRegExp(attr)}(?:\\s|=|>)`, 'i').test(html)
    return attributeTokenExists(html, attr, value)
  }
  return html.includes(trimmed)
}

function attributeTokenExists(html: string, attr: string, token: string): boolean {
  if (!attr || !token) return false
  const pattern = new RegExp(`${escapeRegExp(attr)}\\s*=\\s*(['"])(.*?)\\1`, 'gis')
  for (const match of html.matchAll(pattern)) {
    const rawValue = match[2] ?? ''
    if (rawValue.split(/\s+/).includes(token)) return true
  }
  return false
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function recordFetchCleanup(jobId: string): void {
  recordJobCleanup(jobId, {
    attempted: true,
    succeeded: true,
    remainingPids: [],
  })
}

function browserFetchFailureHint(parsed: URL): string {
  if (isLocalBrowserHost(parsed.hostname)) {
    return 'Recovery: local app fetch failed; verify the server is listening on the exact host/port, try swapping localhost and 127.0.0.1, or use provider=chrome_headless for browser-rendered UI.'
  }
  return 'Recovery: fetch_html could not fetch this page; verify network access or try provider=chrome_headless for browser-rendered UI.'
}

function isLocalBrowserHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

function browserResult(
  jobId: string,
  isError: boolean,
  output: string,
  extraMetadata?: Record<string, unknown>,
): ToolResult {
  const job = getFinishedJob(jobId)
  const artifactSummary = job?.artifacts.length ? formatArtifactSummary(job.artifacts) : ''
  return {
    output: artifactSummary ? `${output}\nartifacts: ${artifactSummary}` : output,
    isError,
    metadata: {
      ...(extraMetadata ?? {}),
      ...(job ? { job } : { jobId }),
    },
  }
}

function getFinishedJob(jobId: string): JobRecord | undefined {
  return getJob(jobId)
}

function formatArtifactSummary(artifacts: JobArtifactRef[]): string {
  return artifacts
    .map((artifact) => `${artifact.artifactType ?? 'artifact'}=${artifact.path}`)
    .join(' ')
}
