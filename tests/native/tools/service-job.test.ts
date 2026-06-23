import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createJobGetTool, createJobListTool } from '../../../src/native/tools/job.js'
import { createServiceJobTool } from '../../../src/native/tools/service-job.js'
import { resetJobSupervisor } from '../../../src/native/job-supervisor.js'
import { NATIVE_TOOL_SCHEMAS } from '../../../src/native/tool-defs.js'

describe('ServiceJob platform tool', () => {
  let tempDir = ''
  let serviceName = ''

  beforeEach(async () => {
    resetJobSupervisor()
    tempDir = await mkdtemp(join(tmpdir(), 'owlcoda-service-job-'))
    serviceName = `demo-${Date.now()}-${Math.random().toString(16).slice(2)}`
  })

  afterEach(async () => {
    await createServiceJobTool().execute({ action: 'stop', serviceName, gracefulStopMs: 200 })
    resetJobSupervisor()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('exposes a service lifecycle schema with start/status/stop/restart actions', () => {
    const schema = NATIVE_TOOL_SCHEMAS['ServiceJob'] as Record<string, any>
    expect(schema.required).toEqual(['action', 'serviceName'])
    expect(schema.properties.action.enum).toEqual(['start', 'status', 'stop', 'restart'])
    expect(schema.properties.healthUrl.description).toContain('health')
    expect(schema.description).toContain('service lifecycle')
  })

  it('starts a local dev service, waits for health, and records PID, port, health, and log artifact', async () => {
    const port = await reservePort()
    const script = await writeDemoService(tempDir)
    const tool = createServiceJobTool()

    const result = await tool.execute({
      action: 'start',
      serviceName,
      command: process.execPath,
      args: [script],
      env: { PORT: String(port) },
      cwd: tempDir,
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      artifactDir: tempDir,
      deadlineMs: 3000,
    })

    expect(result.isError).toBe(false)
    expect(result.output).toContain(`Service job healthy: ${serviceName}`)
    const job = (result.metadata as any).job
    expect(job).toMatchObject({
      type: 'service',
      status: 'running',
      stage: 'healthy',
      provider: 'process',
      tool: 'ServiceJob',
      cwd: tempDir,
      command: `${process.execPath} ${script}`,
      pid: expect.any(Number),
      processGroup: expect.any(Number),
      externalHandle: `127.0.0.1:${port}`,
      recoveryHint: expect.stringContaining('ServiceJob action=status'),
    })
    expect(job.artifacts.map((artifact: any) => artifact.artifactType)).toEqual(['service_log'])
    const logPath = job.artifacts[0].path
    expect(existsSync(logPath)).toBe(true)
    expect(await readFile(logPath, 'utf-8')).toContain(`service listening ${port}`)

    const status = await tool.execute({ action: 'status', serviceName, healthUrl: `http://127.0.0.1:${port}/health` })
    expect(status.isError).toBe(false)
    expect(status.output).toContain('healthy')
    expect((status.metadata as any).job).toMatchObject({
      jobId: job.jobId,
      status: 'running',
      stage: 'healthy',
    })

    const listed = await createJobListTool().execute({ type: 'service' })
    expect((listed.metadata as any).jobs[0]).toMatchObject({
      jobId: job.jobId,
      type: 'service',
      status: 'running',
    })

    const got = await createJobGetTool().execute({ jobId: job.jobId })
    expect(got.output).toContain('Type: service')
    expect(got.output).toContain(logPath)
  })

  it('stops a running service gracefully instead of requiring raw kill commands', async () => {
    const port = await reservePort()
    const script = await writeDemoService(tempDir)
    const tool = createServiceJobTool()
    const started = await tool.execute({
      action: 'start',
      serviceName,
      command: process.execPath,
      args: [script],
      env: { PORT: String(port) },
      cwd: tempDir,
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      artifactDir: tempDir,
      deadlineMs: 3000,
    })
    const startedJob = (started.metadata as any).job

    const stopped = await tool.execute({ action: 'stop', serviceName, gracefulStopMs: 1000 })

    expect(stopped.isError).toBe(false)
    expect(stopped.output).toContain(`Service job stopped: ${serviceName}`)
    expect((stopped.metadata as any).job).toMatchObject({
      jobId: startedJob.jobId,
      status: 'cancelled',
      stage: 'stopped',
      terminationReason: 'service_stop',
      cleanupAttempted: true,
      cleanupSucceeded: true,
      remainingPids: [],
    })
  })

  it('reports spawn errors as structured service job failures', async () => {
    const result = await createServiceJobTool().execute({
      action: 'start',
      serviceName,
      command: join(tempDir, 'missing-service-binary'),
      cwd: tempDir,
      artifactDir: tempDir,
      deadlineMs: 1000,
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('Service job failed')
    expect((result.metadata as any).job).toMatchObject({
      type: 'service',
      status: 'failed',
      stage: 'spawn_error',
      terminationReason: 'spawn_error',
      cleanupAttempted: false,
      cleanupSucceeded: true,
      remainingPids: [],
    })
  })
})

async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  const port = address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function writeDemoService(dir: string): Promise<string> {
  const script = join(dir, 'demo-service.mjs')
  await writeFile(script, `#!/usr/bin/env node
import { createServer } from 'node:http'
const port = Number(process.env.PORT)
const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('demo service')
})
server.listen(port, '127.0.0.1', () => {
  console.log('service listening ' + port)
})
process.on('SIGTERM', () => {
  console.log('service graceful shutdown')
  server.close(() => process.exit(0))
})
`, 'utf-8')
  return script
}
