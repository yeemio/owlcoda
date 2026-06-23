import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createApiJobTool } from '../../../src/native/tools/api-job.js'
import { createJobCancelTool, createJobGetTool, createJobListTool } from '../../../src/native/tools/job.js'
import { resetJobSupervisor } from '../../../src/native/job-supervisor.js'
import { createRunWorkspace, readArtifactLedger } from '../../../src/native/run-workspace.js'
import { NATIVE_TOOL_SCHEMAS } from '../../../src/native/tool-defs.js'

describe('ApiJob platform tool', () => {
  let artifactDir = ''
  let server: Server | undefined
  let baseUrl = ''

  beforeEach(async () => {
    resetJobSupervisor()
    artifactDir = await mkdtemp(join(tmpdir(), 'owlcoda-api-job-'))
    server = createServer((req, res) => {
      if (req.url === '/slow') return
      if (req.url === '/missing') {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, reason: 'backend warming' }))
        return
      }
      if (req.url === '/echo' && req.method === 'POST') {
        let body = ''
        req.setEncoding('utf8')
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json', 'x-owlcoda-test': 'api-job' })
          res.end(JSON.stringify({ method: req.method, body }))
        })
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-owlcoda-test': 'api-job' })
      res.end(JSON.stringify({ ok: true, path: req.url }))
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

  it('exposes supervised API job schema', () => {
    const schema = NATIVE_TOOL_SCHEMAS['ApiJob'] as Record<string, any>
    expect(schema.required).toEqual(['url'])
    expect(schema.properties.method.enum).toEqual(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])
    expect(schema.properties.runRef.description).toContain('RunWorkspace')
  })

  it('runs a supervised GET API job and saves response artifacts', async () => {
    const tool = createApiJobTool()

    const result = await tool.execute({
      url: `${baseUrl}/health`,
      artifactDir,
      deadlineMs: 1000,
    })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('API job completed')
    const job = (result.metadata as any).job
    expect(job).toMatchObject({
      type: 'api',
      status: 'done',
      stage: 'completed',
      provider: 'GET',
      tool: 'ApiJob',
      cwd: process.cwd(),
      recoveryHint: expect.stringContaining('JobGet jobId='),
    })
    expect(job.artifacts.map((artifact: any) => artifact.artifactType)).toEqual(['api_response', 'api_response_headers'])

    const responsePath = job.artifacts.find((artifact: any) => artifact.artifactType === 'api_response').path
    const headersPath = job.artifacts.find((artifact: any) => artifact.artifactType === 'api_response_headers').path
    expect(existsSync(responsePath)).toBe(true)
    expect(await readFile(responsePath, 'utf-8')).toContain('"ok":true')
    expect(await readFile(headersPath, 'utf-8')).toContain('x-owlcoda-test')

    const listed = await createJobListTool().execute({ type: 'api' })
    expect(listed.isError).toBe(false)
    expect((listed.metadata as any).jobs[0]).toMatchObject({
      jobId: job.jobId,
      type: 'api',
      status: 'done',
    })

    const got = await createJobGetTool().execute({ jobId: job.jobId })
    expect(got.isError).toBe(false)
    expect(got.output).toContain('Type: api')
    expect(got.output).toContain('Provider: GET')
    expect(got.output).toContain(responsePath)
  })

  it('records API response artifacts in the run artifact registry with runtime metadata', async () => {
    const outputRoot = join(artifactDir, 'run-output')
    await createRunWorkspace({
      outputRoot,
      cwd: artifactDir,
      taskFamily: 'research',
      deliverableMode: 'file_artifact_delivery',
    })
    const tool = createApiJobTool()

    const result = await tool.execute({
      url: `${baseUrl}/echo`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"ping":true}',
      runRef: outputRoot,
      cwd: artifactDir,
      environment: 'dogfood',
      project: 'owlcoda-platform',
      stepId: 'probe-api',
      participatesInFinal: false,
      deadlineMs: 1000,
    })

    expect(result.isError).toBe(false)
    const job = (result.metadata as any).job
    const ledger = await readArtifactLedger(outputRoot, {}, artifactDir)
    expect(ledger.artifacts).toHaveLength(2)
    expect(job.artifacts.map((artifact: any) => artifact.artifactType)).toEqual(['api_response', 'api_response_headers'])
    for (const artifact of ledger.artifacts) {
      expect(artifact).toMatchObject({
        origin: 'api_job',
        stepId: 'probe-api',
        participatesInFinal: false,
        status: 'present',
      })
      expect(job.artifacts.some((jobArtifact: any) =>
        jobArtifact.id === artifact.id && jobArtifact.path === artifact.path,
      )).toBe(true)
    }
  })

  it('marks non-2xx API responses as http_error while preserving artifacts', async () => {
    const tool = createApiJobTool()

    const result = await tool.execute({
      url: `${baseUrl}/missing`,
      artifactDir,
      deadlineMs: 1000,
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('HTTP 503')
    const job = (result.metadata as any).job
    expect(job).toMatchObject({
      type: 'api',
      status: 'failed',
      stage: 'http_error',
      terminationReason: 'http_error',
      cleanupAttempted: false,
      cleanupSucceeded: true,
    })
    const responsePath = job.artifacts.find((artifact: any) => artifact.artifactType === 'api_response').path
    expect(await readFile(responsePath, 'utf-8')).toContain('backend warming')
  })

  it('cancels a running API job through a live cancel adapter', async () => {
    const tool = createApiJobTool()
    const running = tool.execute({
      url: `${baseUrl}/slow`,
      artifactDir,
      deadlineMs: 5000,
    })

    let jobId = ''
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const listed = await createJobListTool().execute({ type: 'api' })
      const runningJob = ((listed.metadata as any).jobs ?? [])
        .find((job: any) => job.status === 'running' && job.tool === 'ApiJob')
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
      type: 'api',
      status: 'cancelled',
      terminationReason: 'user_cancel',
      cleanupAttempted: true,
      cleanupSucceeded: true,
    })
  })
})
