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

  it('exposes fetch_html, chrome_headless, and chrome_cdp provider schema', () => {
    const schema = NATIVE_TOOL_SCHEMAS['BrowserJob'] as Record<string, any>
    expect(schema.properties.provider.enum).toEqual(['fetch_html', 'chrome_headless', 'chrome_cdp'])
    expect(schema.properties.chromeExecutablePath.description).toContain('Chrome/Chromium')
    expect(schema.properties.clickSelector.description).toContain('provider=chrome_cdp')
    expect(schema.properties.waitForResponseUrlIncludes.description).toContain('network response')
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
      deadlineMs: 1000,
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
  })

  it('runs a chrome_cdp click replay with screenshot, DOM, console, and network artifacts', async () => {
    const fakeChrome = join(artifactDir, 'fake-chrome-cdp.mjs')
    await writeFile(fakeChrome, fakeChromeCdpScript(), 'utf-8')
    await chmod(fakeChrome, 0o755)
    const tool = createBrowserJobTool()

    const result = await tool.execute({
      url: `${baseUrl}/page`,
      provider: 'chrome_cdp',
      chromeExecutablePath: fakeChrome,
      clickSelector: '#capture',
      waitForSelector: '#complete',
      waitForResponseUrlIncludes: '/api/capture',
      artifactDir,
      deadlineMs: 3000,
    })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('clicked=#capture')
    expect(result.output).toContain('response=/api/capture')
    const job = (result.metadata as any).job
    expect(job).toMatchObject({
      type: 'browser',
      status: 'done',
      stage: 'completed',
      provider: 'chrome_cdp',
      cleanupAttempted: true,
      cleanupSucceeded: true,
    })
    expect(job.artifacts.map((artifact: any) => artifact.artifactType)).toEqual([
      'browser_screenshot',
      'browser_dom',
      'browser_text',
      'browser_console',
      'browser_network',
    ])
    const domPath = job.artifacts.find((artifact: any) => artifact.artifactType === 'browser_dom').path
    const textPath = job.artifacts.find((artifact: any) => artifact.artifactType === 'browser_text').path
    const consolePath = job.artifacts.find((artifact: any) => artifact.artifactType === 'browser_console').path
    const networkPath = job.artifacts.find((artifact: any) => artifact.artifactType === 'browser_network').path
    expect(await readFile(domPath, 'utf-8')).toContain('Complete odds')
    expect(await readFile(textPath, 'utf-8')).toContain('Complete odds')
    expect(await readFile(consolePath, 'utf-8')).toContain('capture clicked')
    expect(await readFile(networkPath, 'utf-8')).toContain('/api/capture')
  })

  it('records browser evidence in the run artifact registry with runtime metadata', async () => {
    const outputRoot = join(artifactDir, 'run-output')
    await createRunWorkspace({
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
    expect(job.artifacts.map((artifact: any) => artifact.artifactType)).toEqual(['browser_html', 'browser_text'])
    for (const artifact of ledger.artifacts) {
      expect(artifact).toMatchObject({
        origin: 'browser_job',
        stepId: 'capture-browser-evidence',
        participatesInFinal: false,
        status: 'present',
      })
      expect(job.artifacts.some((jobArtifact: any) =>
        jobArtifact.id === artifact.id && jobArtifact.path === artifact.path,
      )).toBe(true)
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
    expect((result.metadata as any).job).toMatchObject({
      type: 'browser',
      status: 'failed',
      stage: 'selector_missing',
      error: expect.stringContaining('#missing'),
      terminationReason: 'selector_missing',
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

function fakeChromeCdpScript(): string {
  return `#!/usr/bin/env node
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const userDataArg = process.argv.find((arg) => arg.startsWith('--user-data-dir='))
const userDataDir = userDataArg ? userDataArg.slice('--user-data-dir='.length) : process.cwd()
mkdirSync(userDataDir, { recursive: true })
let clicked = false
let upgradedSocket = null

const server = createServer((req, res) => {
  if (req.url === '/json/list') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify([{
      id: 'page-1',
      type: 'page',
      url: 'about:blank',
      webSocketDebuggerUrl: 'ws://127.0.0.1:' + server.address().port + '/devtools/page/1'
    }]))
    return
  }
  res.writeHead(404)
  res.end('not found')
})

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  const accept = createHash('sha1').update(String(key) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n')
  upgradedSocket = socket
  let buffer = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (true) {
      const frame = readFrame(buffer)
      if (!frame) break
      buffer = buffer.subarray(frame.bytes)
      if (frame.opcode === 1) handleMessage(socket, JSON.parse(frame.text))
    }
  })
})

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  writeFileSync(join(userDataDir, 'DevToolsActivePort'), String(port) + '\\n/devtools/browser/fake\\n')
})

function handleMessage(socket, msg) {
  if (msg.method === 'Page.enable' || msg.method === 'Runtime.enable' || msg.method === 'Network.enable') {
    send(socket, { id: msg.id, result: {} })
    return
  }
  if (msg.method === 'Page.navigate') {
    send(socket, { id: msg.id, result: { frameId: 'frame-1' } })
    setTimeout(() => send(socket, { method: 'Page.loadEventFired', params: { timestamp: Date.now() / 1000 } }), 5)
    return
  }
  if (msg.method === 'Input.dispatchMouseEvent') {
    if (msg.params && msg.params.type === 'mouseReleased') {
      clicked = true
      send(socket, { method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ value: 'capture clicked' }] } })
      send(socket, { method: 'Network.responseReceived', params: { response: { url: 'http://127.0.0.1/api/capture', status: 200, mimeType: 'application/json' } } })
    }
    send(socket, { id: msg.id, result: {} })
    return
  }
  if (msg.method === 'Page.captureScreenshot') {
    send(socket, { id: msg.id, result: { data: 'ZmFrZS1wbmc=' } })
    return
  }
  if (msg.method === 'Runtime.evaluate') {
    const expression = String((msg.params && msg.params.expression) || '')
    if (expression.includes('getBoundingClientRect')) {
      send(socket, { id: msg.id, result: { result: { type: 'object', value: { ok: true, x: 24, y: 32, tag: 'BUTTON', text: 'Auto capture' } } } })
      return
    }
    if (expression.includes('document.documentElement.outerHTML')) {
      send(socket, { id: msg.id, result: { result: { type: 'string', value: html() } } })
      return
    }
    if (expression.includes('document.body.innerText')) {
      send(socket, { id: msg.id, result: { result: { type: 'string', value: clicked ? 'Auto capture Complete odds' : 'Auto capture Partial odds' } } })
      return
    }
    if (expression.includes('document.querySelector')) {
      const isComplete = expression.includes('#complete')
      send(socket, { id: msg.id, result: { result: { type: 'boolean', value: isComplete ? clicked : true } } })
      return
    }
    send(socket, { id: msg.id, result: { result: { type: 'undefined' } } })
    return
  }
  send(socket, { id: msg.id, result: {} })
}

function html() {
  return clicked
    ? '<!doctype html><body><button id="capture">Auto capture</button><main id="complete">Complete odds</main></body>'
    : '<!doctype html><body><button id="capture">Auto capture</button><main id="partial">Partial odds</main></body>'
}

function send(socket, value) {
  const payload = Buffer.from(JSON.stringify(value))
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length])
  } else {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
  }
  socket.write(Buffer.concat([header, payload]))
}

function readFrame(buffer) {
  if (buffer.length < 2) return null
  const opcode = buffer[0] & 0x0f
  const masked = (buffer[1] & 0x80) !== 0
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  }
  const maskOffset = masked ? offset : -1
  if (masked) offset += 4
  if (buffer.length < offset + length) return null
  const payload = Buffer.from(buffer.subarray(offset, offset + length))
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4)
    for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i] ^ mask[i % 4]
  }
  return { opcode, text: payload.toString('utf-8'), bytes: offset + length }
}

process.on('SIGTERM', () => {
  if (upgradedSocket) upgradedSocket.destroy()
  server.close(() => process.exit(0))
})
`
}
