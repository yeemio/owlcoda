import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBrowserJobTool } from '../../../src/native/tools/browser-job.js'
import { createJobCancelTool, createJobGetTool, createJobListTool } from '../../../src/native/tools/job.js'
import { resetJobSupervisor } from '../../../src/native/job-supervisor.js'
import { createRunWorkspace, readArtifactLedger } from '../../../src/native/run-workspace.js'
import { NATIVE_TOOL_SCHEMAS } from '../../../src/native/tool-defs.js'

describe('BrowserJob platform tool', () => {
  let artifactDir = ''
  let server: Server | undefined
  let baseUrl = ''

  beforeEach(async () => {
    resetJobSupervisor()
    artifactDir = await mkdtemp(join(tmpdir(), 'owlcoda-browser-job-'))
    server = createServer((req, res) => {
      if (req.url === '/slow') return
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(`<!doctype html>
        <html>
          <head><title>Browser Job Test</title></head>
          <body>
            <main id="scoreboard" class="panel">Live odds board</main>
            <script>window.__secret = 'ignored'</script>
          </body>
        </html>`)
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind to a port')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    resetJobSupervisor()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
    await rm(artifactDir, { recursive: true, force: true })
  })

	  it('exposes fetch_html and chrome_headless provider schema', () => {
	    const schema = NATIVE_TOOL_SCHEMAS['BrowserJob'] as Record<string, any>
	    expect(schema.properties.provider.enum).toEqual(['fetch_html', 'chrome_headless'])
	    expect(schema.properties.chromeExecutablePath.description).toContain('Chrome/Chromium')
	    expect(schema.properties.artifactDir.description).toContain('~/.owlcoda/browser-jobs')
	    expect(schema.properties.artifactDir.description).not.toContain('.owlcoda-browser-jobs under cwd')
	  })

  it('captures a URL as a browser job with queryable artifacts', async () => {
    const tool = createBrowserJobTool()

    const result = await tool.execute({
      url: `${baseUrl}/page`,
      waitForSelector: '#scoreboard',
      artifactDir,
      deadlineMs: 1000,
    })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('Browser job completed')
    expect(result.output).toContain('selector=#scoreboard')
    expect(result.output).toContain('artifacts:')
    expect(result.output).toContain('browser_text=')
    const job = (result.metadata as any).job
    expect(job).toMatchObject({
      type: 'browser',
      status: 'done',
      stage: 'completed',
      provider: 'fetch_html',
      tool: 'BrowserJob',
      cwd: process.cwd(),
      recoveryHint: expect.stringContaining('JobGet jobId='),
    })
    expect(job.artifacts.map((artifact: any) => artifact.artifactType)).toEqual(['browser_html', 'browser_text'])

    const htmlPath = job.artifacts.find((artifact: any) => artifact.artifactType === 'browser_html').path
    const textPath = job.artifacts.find((artifact: any) => artifact.artifactType === 'browser_text').path
    expect(existsSync(htmlPath)).toBe(true)
    expect(await readFile(textPath, 'utf-8')).toContain('Live odds board')

    const jobList = createJobListTool()
    const listed = await jobList.execute({ type: 'browser' })
    expect(listed.isError).toBe(false)
    expect((listed.metadata as any).jobs[0]).toMatchObject({
      jobId: job.jobId,
      type: 'browser',
      status: 'done',
    })

    const jobGet = createJobGetTool()
    const got = await jobGet.execute({ jobId: job.jobId })
    expect(got.isError).toBe(false)
    expect(got.output).toContain('Type: browser')
    expect(got.output).toContain(htmlPath)
    expect(got.output).toContain('Provider: fetch_html')
  })

  it('stores default browser artifacts under OWLCODA_HOME instead of polluting the project cwd', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-browser-job-cwd-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-browser-job-home-'))
    const previousHome = process.env['OWLCODA_HOME']
    const tool = createBrowserJobTool()
    try {
      process.env['OWLCODA_HOME'] = home
      const result = await tool.execute({
        url: `${baseUrl}/page`,
        cwd,
        deadlineMs: 1000,
      })

      expect(result.isError).toBe(false)
      const job = (result.metadata as any).job
      const htmlPath = job.artifacts.find((artifact: any) => artifact.artifactType === 'browser_html').path
      expect(htmlPath).toContain(join(home, 'browser-jobs'))
      expect(existsSync(join(cwd, '.owlcoda-browser-jobs'))).toBe(false)
    } finally {
      if (previousHome === undefined) delete process.env['OWLCODA_HOME']
      else process.env['OWLCODA_HOME'] = previousHome
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('captures a URL through a chrome_headless provider with screenshot and DOM artifacts', async () => {
    const fakeChrome = join(artifactDir, 'fake-chrome.mjs')
    await writeFile(fakeChrome, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
const screenshotArg = process.argv.find((arg) => arg.startsWith('--screenshot='))
if (screenshotArg) writeFileSync(screenshotArg.slice('--screenshot='.length), 'fake-png')
console.log('<!doctype html><main id="scoreboard">Chrome rendered odds board</main>')
`, 'utf-8')
    await chmod(fakeChrome, 0o755)
    const tool = createBrowserJobTool()

    const result = await tool.execute({
      url: `${baseUrl}/page`,
      provider: 'chrome_headless',
      chromeExecutablePath: fakeChrome,
      waitForSelector: '#scoreboard',
      artifactDir,
      deadlineMs: 5000,
    })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('Browser job completed')
    const job = (result.metadata as any).job
    expect(job).toMatchObject({
      type: 'browser',
      status: 'done',
      stage: 'completed',
      provider: 'chrome_headless',
      cleanupAttempted: true,
      cleanupSucceeded: true,
    })
    expect(job.artifacts.map((artifact: any) => artifact.artifactType)).toEqual([
      'browser_screenshot',
      'browser_dom',
      'browser_text',
    ])
    const screenshotPath = job.artifacts.find((artifact: any) => artifact.artifactType === 'browser_screenshot').path
    const domPath = job.artifacts.find((artifact: any) => artifact.artifactType === 'browser_dom').path
    const textPath = job.artifacts.find((artifact: any) => artifact.artifactType === 'browser_text').path
    expect(existsSync(screenshotPath)).toBe(true)
    expect(await readFile(domPath, 'utf-8')).toContain('Chrome rendered odds board')
    expect(await readFile(textPath, 'utf-8')).toContain('Chrome rendered odds board')
  })

  it('reports chrome_headless as provider_not_configured when no executable is available', async () => {
    const tool = createBrowserJobTool()

    const result = await tool.execute({
      url: `${baseUrl}/page`,
      provider: 'chrome_headless',
      chromeExecutablePath: join(artifactDir, 'missing-chrome'),
      artifactDir,
      deadlineMs: 1000,
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('chrome_headless provider is not configured')
    expect((result.metadata as any).job).toMatchObject({
      type: 'browser',
      provider: 'chrome_headless',
      status: 'failed',
      stage: 'provider_not_configured',
      terminationReason: 'provider_not_configured',
    })
    expect((result.metadata as any).captureFailureReceipt).toMatchObject({
      captureFailureStage: 'permission',
      provider: 'chrome_headless',
      attempts: 1,
      url: `${baseUrl}/page`,
      recoverable: true,
    })
  })

  it('preserves partial chrome_headless evidence when capture times out after producing DOM', async () => {
    const fakeChrome = join(artifactDir, 'slow-fake-chrome.mjs')
    await writeFile(fakeChrome, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
const screenshotArg = process.argv.find((arg) => arg.startsWith('--screenshot='))
if (screenshotArg) writeFileSync(screenshotArg.slice('--screenshot='.length), 'partial-png')
console.error('partial stderr before hang')
console.log('<!doctype html><main id="scoreboard">Partial rendered odds board</main>')
await new Promise((resolve) => setTimeout(resolve, 1000))
`, 'utf-8')
    await chmod(fakeChrome, 0o755)
    const tool = createBrowserJobTool()

    const result = await tool.execute({
      url: `${baseUrl}/page`,
      provider: 'chrome_headless',
      chromeExecutablePath: fakeChrome,
      artifactDir,
      deadlineMs: 700,
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('timed out')
    expect(result.output).toContain('artifacts:')
    const job = (result.metadata as any).job
    expect(job).toMatchObject({
      type: 'browser',
      status: 'timeout',
      stage: 'timeout',
      provider: 'chrome_headless',
      terminationReason: 'deadline_exceeded',
    })
    expect(job.artifacts.map((artifact: any) => artifact.artifactType)).toEqual(expect.arrayContaining([
      'browser_screenshot',
      'browser_dom',
      'browser_text',
      'browser_capture_failure_receipt',
    ]))
    expect((result.metadata as any).captureFailureReceipt).toMatchObject({
      captureFailureStage: 'timeout',
      provider: 'chrome_headless',
      attempts: 1,
      url: `${baseUrl}/page`,
      durationMs: expect.any(Number),
    })
    const screenshotPath = job.artifacts.find((artifact: any) => artifact.artifactType === 'browser_screenshot').path
    const textPath = job.artifacts.find((artifact: any) => artifact.artifactType === 'browser_text').path
    expect(existsSync(screenshotPath)).toBe(true)
    expect(await readFile(textPath, 'utf-8')).toContain('Partial rendered odds board')
  })

  it('records browser evidence in the run artifact registry with runtime metadata', async () => {
    const outputRoot = join(artifactDir, 'run-output')
    const { manifest } = await createRunWorkspace({
      outputRoot,
      cwd: artifactDir,
      taskFamily: 'research',
      deliverableMode: 'file_artifact_delivery',
    })
    const tool = createBrowserJobTool()

    const result = await tool.execute({
      url: `${baseUrl}/page`,
      waitForSelector: '#scoreboard',
      runRef: outputRoot,
      cwd: artifactDir,
      environment: 'dogfood',
      project: 'owlcoda-platform',
      stepId: 'capture-browser-evidence',
      participatesInFinal: false,
      deadlineMs: 1000,
    })

    expect(result.isError).toBe(false)
    const job = (result.metadata as any).job
    const ledger = await readArtifactLedger(outputRoot, {}, artifactDir)
    expect(ledger.artifacts).toHaveLength(2)
    expect(ledger.artifacts.map((artifact) => artifact.artifactType)).toEqual(['browser_html', 'browser_text'])
    for (const artifact of ledger.artifacts) {
      expect(artifact).toMatchObject({
        origin: 'browser_job',
        environment: 'dogfood',
        project: 'owlcoda-platform',
        runId: manifest.runId,
        jobId: job.jobId,
        stepId: 'capture-browser-evidence',
        participatesInFinal: false,
        status: 'present',
      })
      expect(job.artifacts.some((jobArtifact: any) => jobArtifact.id === artifact.id)).toBe(true)
    }
  })

  it('marks selector misses as structured browser job failures', async () => {
    const tool = createBrowserJobTool()

    const result = await tool.execute({
      url: `${baseUrl}/page`,
      waitForSelector: '#missing',
      artifactDir,
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('selector not found')
    expect(result.output).toContain('fetch_html captures static HTML')
    expect(result.output).toContain('provider=chrome_headless')
    expect(result.output).toContain('artifacts:')
    expect(result.output).toContain('browser_text=')
    expect((result.metadata as any).job).toMatchObject({
      type: 'browser',
      status: 'failed',
      stage: 'selector_missing',
      error: expect.stringContaining('#missing'),
      terminationReason: 'selector_missing',
    })
    expect((result.metadata as any).captureFailureReceipt).toMatchObject({
      captureFailureStage: 'selector',
      selector: '#missing',
      provider: 'fetch_html',
      attempts: 1,
      url: `${baseUrl}/page`,
      artifactRefs: expect.any(Array),
    })
    const job = (result.metadata as any).job
    expect(job.artifacts.map((artifact: any) => artifact.artifactType)).toEqual(expect.arrayContaining([
      'browser_html',
      'browser_text',
      'browser_capture_failure_receipt',
    ]))
    const textPath = job.artifacts.find((artifact: any) => artifact.artifactType === 'browser_text').path
    expect(await readFile(textPath, 'utf-8')).toContain('Live odds board')
  })

  it('classifies fetch_html connection failures with local recovery hints', async () => {
    const tool = createBrowserJobTool()

    const result = await tool.execute({
      url: 'http://127.0.0.1:1/',
      waitForSelector: 'header',
      artifactDir,
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('Browser job failed')
    expect(result.output).toContain('local app')
    expect(result.output).toContain('exact host/port')
    expect(result.output).toContain('provider=chrome_headless')
    expect((result.metadata as any).failureCategory).toBe('browser-job:fetch-failed')
    expect((result.metadata as any).recoverable).toBe(true)
    expect((result.metadata as any).captureFailureReceipt).toMatchObject({
      captureFailureStage: 'network',
      provider: 'fetch_html',
      attempts: 1,
      url: 'http://127.0.0.1:1/',
      recoverable: true,
    })
  })

  it('marks timed out browser jobs as timeout with cleanup evidence', async () => {
    const tool = createBrowserJobTool()

    const result = await tool.execute({
      url: `${baseUrl}/slow`,
      artifactDir,
      deadlineMs: 20,
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('timed out')
    expect((result.metadata as any).job).toMatchObject({
      type: 'browser',
      status: 'timeout',
      stage: 'timeout',
      terminationReason: 'deadline_exceeded',
      cleanupAttempted: true,
      cleanupSucceeded: true,
      remainingPids: [],
    })
    expect((result.metadata as any).captureFailureReceipt).toMatchObject({
      captureFailureStage: 'timeout',
      provider: 'fetch_html',
      attempts: 1,
      url: `${baseUrl}/slow`,
      durationMs: expect.any(Number),
    })
  })

  it('cancels a running fetch_html browser job through a live cancel adapter', async () => {
    const tool = createBrowserJobTool()
    const running = tool.execute({
      url: `${baseUrl}/slow`,
      artifactDir,
      deadlineMs: 5000,
    })

    let jobId = ''
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const listed = await createJobListTool().execute({ type: 'browser' })
      const runningJob = ((listed.metadata as any).jobs ?? []).find((job: any) => job.status === 'running')
      if (runningJob) {
        jobId = runningJob.jobId
        break
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(jobId).toBeTruthy()

    const cancelled = await createJobCancelTool().execute({ jobId })
    expect(cancelled.isError).toBe(false)
    expect(cancelled.output).toContain('live cancel adapter')
    expect((cancelled.metadata as any).liveCancelAdapter).toBe(true)

    const result = await running
    expect(result.isError).toBe(true)
    expect((result.metadata as any).job).toMatchObject({
      jobId,
      type: 'browser',
      status: 'cancelled',
      terminationReason: 'user_cancel',
      cleanupAttempted: true,
      cleanupSucceeded: true,
    })
  })
})
