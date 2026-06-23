import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
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
  clickSelector?: string
  waitForResponseUrlIncludes?: string
  waitAfterClickMs?: number
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
const CHROME_CDP_PROVIDER = 'chrome_cdp'
const SUPPORTED_PROVIDERS = new Set([FETCH_HTML_PROVIDER, CHROME_HEADLESS_PROVIDER, CHROME_CDP_PROVIDER])
type BrowserChildProcess = ChildProcessByStdio<null, Readable, Readable>

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
      const provider = input.provider?.trim() || (input.clickSelector || input.waitForResponseUrlIncludes ? CHROME_CDP_PROVIDER : FETCH_HTML_PROVIDER)
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
        if (provider === CHROME_CDP_PROVIDER) {
          return await runChromeCdpJob({
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

        if (input.waitForSelector && !selectorExists(html, input.waitForSelector)) {
          const message = `selector not found: ${input.waitForSelector}`
          appendJobOutput(jobId, `${message}\n`)
          finishJob(jobId, 'failed', {
            stage: 'selector_missing',
            error: message,
            terminationReason: 'selector_missing',
          })
          recordFetchCleanup(jobId)
          return browserResult(jobId, true, `Browser job failed: ${message}`)
        }

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
        return browserResult(
          jobId,
          true,
          timedOut
            ? `Browser job timed out after ${deadlineMs}ms: ${jobId}`
            : `Browser job failed: ${message}`,
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
  if (input.clickSelector !== undefined && (typeof input.clickSelector !== 'string' || !input.clickSelector.trim())) {
    return { output: 'Error: clickSelector must be a non-empty string when provided.', isError: true }
  }
  if (input.waitForResponseUrlIncludes !== undefined && (typeof input.waitForResponseUrlIncludes !== 'string' || !input.waitForResponseUrlIncludes.trim())) {
    return { output: 'Error: waitForResponseUrlIncludes must be a non-empty string when provided.', isError: true }
  }
  if ((input.clickSelector || input.waitForResponseUrlIncludes) && input.provider !== undefined && input.provider.trim() !== CHROME_CDP_PROVIDER) {
    return { output: 'Error: clickSelector and waitForResponseUrlIncludes require provider=chrome_cdp.', isError: true }
  }
  if (input.waitAfterClickMs !== undefined && (typeof input.waitAfterClickMs !== 'number' || !Number.isFinite(input.waitAfterClickMs) || input.waitAfterClickMs < 0)) {
    return { output: 'Error: waitAfterClickMs must be a non-negative number when provided.', isError: true }
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
    finishJob(args.jobId, 'done', { stage: 'completed' })
    await cleanupChromeProfile(args.jobId, profileDir)
    const selectorNote = args.input.waitForSelector ? ` selector=${args.input.waitForSelector}` : ''
    return browserResult(args.jobId, false, `Browser job completed: ${args.jobId}${selectorNote}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const timedOut = isAbortLikeError(err) || isExecTimeoutError(err)
    appendJobOutput(args.jobId, `${message}\n`)
    if (getJob(args.jobId)?.status === 'cancelled') {
      await cleanupChromeProfile(args.jobId, profileDir)
      return browserResult(args.jobId, true, `Browser job cancelled: ${args.jobId}`)
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

async function runChromeCdpJob(args: {
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
    const message = 'chrome_cdp provider is not configured: set chromeExecutablePath or install Chrome/Chromium.'
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
  const consolePath = resolve(dir, 'console.json')
  const networkPath = resolve(dir, 'network.json')
  await mkdir(profileDir, { recursive: true })

  let child: BrowserChildProcess | undefined
  let cdp: CdpConnection | undefined
  const consoleEvents: unknown[] = []
  const networkEvents: unknown[] = []
  const signal = composeAbortSignal(args.deadlineMs, args.context?.signal, args.liveCancelSignal)

  try {
    startJob(args.jobId, { stage: 'launching', externalHandle: executable })
    appendJobOutput(args.jobId, `Launching chrome_cdp executable=${executable}\n`)
    child = spawn(executable, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profileDir}`,
      '--window-size=1280,900',
      '--remote-debugging-port=0',
      'about:blank',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', chunk => appendJobOutput(args.jobId, chunk.toString('utf-8')))
    child.stderr.on('data', chunk => appendJobOutput(args.jobId, chunk.toString('utf-8')))

    const port = await waitForDevToolsPort(profileDir, args.deadlineMs, signal)
    startJob(args.jobId, {
      stage: 'navigating',
      pid: child.pid,
      processGroup: child.pid,
      externalHandle: `cdp:127.0.0.1:${port}`,
    })
    const webSocketUrl = await getPageWebSocketUrl(port, signal)
    cdp = await CdpConnection.connect(webSocketUrl, signal)
    cdp.on('Runtime.consoleAPICalled', params => consoleEvents.push(simplifyConsoleEvent(params)))
    cdp.on('Network.responseReceived', params => networkEvents.push(simplifyNetworkEvent(params)))

    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Network.enable')
    const loadEvent = cdp.waitForEvent('Page.loadEventFired', signal, Math.min(args.deadlineMs, 10_000))
    await cdp.send('Page.navigate', { url: args.parsed.href })
    await loadEvent
    appendJobOutput(args.jobId, `Chrome CDP navigated ${args.parsed.href}\n`)

    let clickNote = ''
    if (args.input.clickSelector?.trim()) {
      startJob(args.jobId, { stage: 'clicking', externalHandle: `cdp:127.0.0.1:${port}` })
      const selector = args.input.clickSelector.trim()
      const target = await evaluateCdpValue(cdp, clickPointExpression(selector))
      if (!target || typeof target !== 'object' || !(target as { ok?: unknown }).ok) {
        const message = `click selector not found: ${selector}`
        appendJobOutput(args.jobId, `${message}\n`)
        finishJob(args.jobId, 'failed', {
          stage: 'click_selector_missing',
          error: message,
          terminationReason: 'click_selector_missing',
        })
        await cleanupChromeCdp(args.jobId, child, profileDir)
        return browserResult(args.jobId, true, `Browser job failed: ${message}`)
      }
      const point = target as { x: number; y: number }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      clickNote = ` clicked=${selector}`
      appendJobOutput(args.jobId, `Clicked ${selector}\n`)
      if (args.input.waitAfterClickMs && args.input.waitAfterClickMs > 0) {
        await delayWithAbort(args.input.waitAfterClickMs, signal)
      }
    }

    let responseNote = ''
    if (args.input.waitForResponseUrlIncludes?.trim()) {
      const needle = args.input.waitForResponseUrlIncludes.trim()
      await waitForNetworkResponse(cdp, networkEvents, needle, signal, Math.min(args.deadlineMs, 10_000))
      responseNote = ` response=${needle}`
      appendJobOutput(args.jobId, `Observed network response ${needle}\n`)
    }

    if (args.input.waitForSelector?.trim()) {
      await waitForCdpSelector(cdp, args.input.waitForSelector.trim(), signal, Math.min(args.deadlineMs, 10_000))
      appendJobOutput(args.jobId, `Observed selector ${args.input.waitForSelector.trim()}\n`)
    }

    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    await writeFile(screenshotPath, Buffer.from(String(screenshot.data ?? ''), 'base64'))
    const html = String(await evaluateCdpValue(cdp, 'document.documentElement.outerHTML') ?? '')
    const text = String(await evaluateCdpValue(cdp, 'document.body ? document.body.innerText : ""') ?? htmlToText(html))
    await writeFile(domPath, html, 'utf-8')
    await writeFile(textPath, text, 'utf-8')
    await writeFile(consolePath, `${JSON.stringify(consoleEvents, null, 2)}\n`, 'utf-8')
    await writeFile(networkPath, `${JSON.stringify(networkEvents, null, 2)}\n`, 'utf-8')

    const artifacts = [
      { path: screenshotPath, artifactType: 'browser_screenshot' },
      { path: domPath, artifactType: 'browser_dom' },
      { path: textPath, artifactType: 'browser_text' },
      { path: consolePath, artifactType: 'browser_console' },
      { path: networkPath, artifactType: 'browser_network' },
    ]
    const recordedArtifacts = await recordBrowserArtifacts({
      artifacts,
      input: args.input,
      jobId: args.jobId,
      cwd: args.cwd,
    })
    addJobArtifacts(args.jobId, recordedArtifacts)
    appendJobOutput(args.jobId, `Saved ${artifacts.length} chrome_cdp artifact(s)\n`)
    finishJob(args.jobId, 'done', { stage: 'completed' })
    await cleanupChromeCdp(args.jobId, child, profileDir)
    return browserResult(args.jobId, false, `Browser job completed: ${args.jobId}${clickNote}${responseNote}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const timedOut = isAbortLikeError(err)
    appendJobOutput(args.jobId, `${message}\n`)
    if (getJob(args.jobId)?.status === 'cancelled') {
      await cleanupChromeCdp(args.jobId, child, profileDir)
      return browserResult(args.jobId, true, `Browser job cancelled: ${args.jobId}`)
    }
    finishJob(args.jobId, timedOut ? 'timeout' : 'failed', {
      stage: timedOut ? 'timeout' : 'failed',
      error: timedOut ? `chrome_cdp timed out after ${args.deadlineMs}ms` : message,
      terminationReason: timedOut ? 'deadline_exceeded' : 'execution_error',
    })
    await cleanupChromeCdp(args.jobId, child, profileDir)
    return browserResult(
      args.jobId,
      true,
      timedOut
        ? `Browser job timed out after ${args.deadlineMs}ms: ${args.jobId}`
        : `Browser job failed: ${message}`,
    )
  } finally {
    cdp?.close()
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
      if (error) reject(error)
      else resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

async function waitForDevToolsPort(profileDir: string, deadlineMs: number, signal: AbortSignal): Promise<number> {
  const path = resolve(profileDir, 'DevToolsActivePort')
  const deadlineAt = Date.now() + deadlineMs
  while (Date.now() < deadlineAt) {
    throwIfAborted(signal)
    try {
      const text = await readFile(path, 'utf-8')
      const port = Number.parseInt(text.split(/\r?\n/)[0] ?? '', 10)
      if (Number.isInteger(port) && port > 0) return port
    } catch {
      // Chrome writes DevToolsActivePort asynchronously after launch.
    }
    await delayWithAbort(50, signal)
  }
  throw new Error(`timed out waiting for Chrome DevToolsActivePort in ${profileDir}`)
}

async function getPageWebSocketUrl(port: number, signal: AbortSignal): Promise<string> {
  throwIfAborted(signal)
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
  })
  if (!response.ok) throw new Error(`Chrome CDP target list failed: HTTP ${response.status}`)
  const targets = await response.json() as Array<{ type?: string; webSocketDebuggerUrl?: string }>
  const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl)
  if (!page?.webSocketDebuggerUrl) throw new Error('Chrome CDP page target was not available')
  return page.webSocketDebuggerUrl
}

async function evaluateCdpValue(cdp: CdpConnection, expression: string): Promise<unknown> {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false,
  })
  return response?.result?.value
}

function clickPointExpression(selector: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: 'selector not found' };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return { ok: false, reason: 'selector has no clickable box' };
    return {
      ok: true,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      tag: el.tagName,
      text: (el.textContent || '').slice(0, 200)
    };
  })()`
}

async function waitForCdpSelector(
  cdp: CdpConnection,
  selector: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs
  const expression = `document.querySelector(${JSON.stringify(selector)}) !== null`
  while (Date.now() < deadlineAt) {
    throwIfAborted(signal)
    if (await evaluateCdpValue(cdp, expression) === true) return
    await delayWithAbort(100, signal)
  }
  throw new Error(`selector not found: ${selector}`)
}

async function waitForNetworkResponse(
  cdp: CdpConnection,
  networkEvents: unknown[],
  needle: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  const matches = (event: unknown): boolean => JSON.stringify(event).includes(needle)
  if (networkEvents.some(matches)) return
  await cdp.waitForEvent('Network.responseReceived', signal, timeoutMs, matches)
}

function simplifyConsoleEvent(params: unknown): unknown {
  const record = params as { type?: unknown; args?: Array<{ value?: unknown; description?: unknown }> }
  return {
    type: typeof record.type === 'string' ? record.type : 'log',
    values: Array.isArray(record.args)
      ? record.args.map(arg => arg.value ?? arg.description ?? '').filter(value => value !== '')
      : [],
  }
}

function simplifyNetworkEvent(params: unknown): unknown {
  const record = params as { response?: { url?: unknown; status?: unknown; mimeType?: unknown } }
  return {
    url: typeof record.response?.url === 'string' ? record.response.url : '',
    status: typeof record.response?.status === 'number' ? record.response.status : undefined,
    mimeType: typeof record.response?.mimeType === 'string' ? record.response.mimeType : undefined,
  }
}

async function cleanupChromeCdp(
  jobId: string,
  child: BrowserChildProcess | undefined,
  profileDir: string,
): Promise<void> {
  let processStopped = true
  let remainingPids: number[] = []
  if (child && isBrowserChildRunning(child)) {
    child.kill('SIGTERM')
    processStopped = await waitForBrowserChildExit(child, 1_000)
    if (!processStopped && isBrowserChildRunning(child)) {
      child.kill('SIGKILL')
      processStopped = await waitForBrowserChildExit(child, 1_000)
    }
    if (!processStopped && child.pid) remainingPids = [child.pid]
  }
  try {
    await rm(profileDir, { recursive: true, force: true })
    recordJobCleanup(jobId, {
      attempted: true,
      succeeded: processStopped,
      remainingPids,
    })
  } catch {
    recordJobCleanup(jobId, {
      attempted: true,
      succeeded: false,
      remainingPids,
    })
  }
}

function isBrowserChildRunning(child: BrowserChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null && !child.killed
}

function waitForBrowserChildExit(child: BrowserChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isBrowserChildRunning(child)) return Promise.resolve(true)
  return new Promise((resolvePromise) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit)
      resolvePromise(false)
    }, timeoutMs)
    const onExit = (): void => {
      clearTimeout(timeout)
      resolvePromise(true)
    }
    child.once('exit', onExit)
  })
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('browser job aborted')
}

function delayWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timeout)
      reject(new Error('browser job aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

interface CdpEventWaiter {
  method: string
  predicate?: (params: unknown) => boolean
  resolve: (params: unknown) => void
  reject: (err: Error) => void
}

class CdpConnection {
  private nextId = 1
  private buffer = Buffer.alloc(0)
  private readonly pending = new Map<number, {
    resolve: (value: any) => void
    reject: (err: Error) => void
    timeout: NodeJS.Timeout
  }>()
  private readonly listeners = new Map<string, Array<(params: unknown) => void>>()
  private readonly waiters: CdpEventWaiter[] = []

  private constructor(private readonly socket: Socket) {
    socket.on('data', chunk => this.handleData(chunk))
    socket.on('error', err => this.rejectAll(err instanceof Error ? err : new Error(String(err))))
    socket.on('close', () => this.rejectAll(new Error('Chrome CDP socket closed')))
  }

  static connect(webSocketUrl: string, signal: AbortSignal): Promise<CdpConnection> {
    const parsed = new URL(webSocketUrl)
    if (parsed.protocol !== 'ws:') throw new Error(`unsupported Chrome CDP websocket protocol: ${parsed.protocol}`)
    const port = Number.parseInt(parsed.port || '80', 10)
    const path = `${parsed.pathname}${parsed.search}`
    const key = randomBytes(16).toString('base64')

    return new Promise((resolvePromise, reject) => {
      const socket = createConnection({ host: parsed.hostname, port })
      let handshake = Buffer.alloc(0)
      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort)
        socket.off('error', onError)
        socket.off('data', onData)
      }
      const onAbort = (): void => {
        cleanup()
        socket.destroy()
        reject(new Error('browser job aborted'))
      }
      const onError = (err: Error): void => {
        cleanup()
        reject(err)
      }
      const onData = (chunk: Buffer): void => {
        handshake = Buffer.concat([handshake, chunk])
        const headerEnd = handshake.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        const header = handshake.subarray(0, headerEnd).toString('utf-8')
        if (!/^HTTP\/1\.1 101\b/i.test(header)) {
          cleanup()
          socket.destroy()
          reject(new Error(`Chrome CDP websocket upgrade failed: ${header.split('\r\n')[0] ?? header}`))
          return
        }
        const leftover = handshake.subarray(headerEnd + 4)
        cleanup()
        const connection = new CdpConnection(socket)
        if (leftover.length > 0) connection.handleData(leftover)
        resolvePromise(connection)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      socket.once('error', onError)
      socket.on('data', onData)
      socket.on('connect', () => {
        socket.write([
          `GET ${path} HTTP/1.1`,
          `Host: ${parsed.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'))
      })
    })
  }

  on(method: string, handler: (params: unknown) => void): void {
    const handlers = this.listeners.get(method) ?? []
    handlers.push(handler)
    this.listeners.set(method, handlers)
  }

  send(method: string, params?: Record<string, unknown>, timeoutMs = 5_000): Promise<any> {
    const id = this.nextId
    this.nextId += 1
    const payload = JSON.stringify({ id, method, ...(params ? { params } : {}) })
    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Chrome CDP command timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolvePromise, reject, timeout })
      this.socket.write(maskedWebSocketFrame(payload))
    })
  }

  waitForEvent(
    method: string,
    signal: AbortSignal,
    timeoutMs: number,
    predicate?: (params: unknown) => boolean,
  ): Promise<unknown> {
    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error(`Chrome CDP event timed out: ${method}`))
      }, timeoutMs)
      const waiter: CdpEventWaiter = {
        method,
        predicate,
        resolve: (params) => {
          cleanup()
          resolvePromise(params)
        },
        reject: (err) => {
          cleanup()
          reject(err)
        },
      }
      const cleanup = (): void => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
        const index = this.waiters.indexOf(waiter)
        if (index !== -1) this.waiters.splice(index, 1)
      }
      const onAbort = (): void => waiter.reject(new Error('browser job aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  close(): void {
    this.socket.destroy()
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (true) {
      const frame = readWebSocketFrame(this.buffer)
      if (!frame) break
      this.buffer = this.buffer.subarray(frame.bytes)
      if (frame.opcode === 1) this.handleMessage(frame.text)
    }
  }

  private handleMessage(text: string): void {
    const message = JSON.parse(text) as { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timeout)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message ?? 'Chrome CDP command failed'))
      else pending.resolve(message.result)
      return
    }
    if (!message.method) return
    for (const handler of this.listeners.get(message.method) ?? []) handler(message.params)
    for (const waiter of [...this.waiters]) {
      if (waiter.method !== message.method) continue
      if (waiter.predicate && !waiter.predicate(message.params)) continue
      waiter.resolve(message.params)
    }
  }

  private rejectAll(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout)
      pending.reject(err)
    }
    this.pending.clear()
    for (const waiter of [...this.waiters]) waiter.reject(err)
  }
}

function maskedWebSocketFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf-8')
  const mask = randomBytes(4)
  const header = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : Buffer.from([0x81, 0x80 | 126, (payload.length >> 8) & 0xff, payload.length & 0xff])
  const masked = Buffer.alloc(payload.length)
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index]! ^ mask[index % 4]!
  }
  return Buffer.concat([header, mask, masked])
}

function readWebSocketFrame(buffer: Buffer): { opcode: number; text: string; bytes: number } | null {
  if (buffer.length < 2) return null
  const opcode = buffer[0]! & 0x0f
  let length = buffer[1]! & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  const masked = (buffer[1]! & 0x80) !== 0
  const maskOffset = masked ? offset : -1
  if (masked) offset += 4
  if (buffer.length < offset + length) return null
  const payload = Buffer.from(buffer.subarray(offset, offset + length))
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4)
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = payload[index]! ^ mask[index % 4]!
    }
  }
  return { opcode, text: payload.toString('utf-8'), bytes: offset + length }
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
      ...(args.input.stepId?.trim() ? { stepId: args.input.stepId } : {}),
      ...(typeof args.input.participatesInFinal === 'boolean' ? { participatesInFinal: args.input.participatesInFinal } : {}),
    }, args.cwd)
    recorded.push({
      id: record.id,
      path: record.path,
      artifactType: artifact.artifactType,
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

function browserResult(jobId: string, isError: boolean, output: string): ToolResult {
  const job = getFinishedJob(jobId)
  return {
    output,
    isError,
    metadata: job ? { job } : { jobId },
  }
}

function getFinishedJob(jobId: string): JobRecord | undefined {
  return getJob(jobId)
}
