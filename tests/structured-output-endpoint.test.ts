import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/server.js'
import type { OwlCodaConfig } from '../src/config.js'
import { createRunWorkspace, readArtifactLedger } from '../src/native/run-workspace.js'

let backend: http.Server
let backendUrl = ''
let app: http.Server
let appUrl = ''
const backendBodies: any[] = []

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    let raw = ''
    req.on('data', chunk => { raw += chunk.toString() })
    req.on('end', () => resolve(raw))
  })
}

beforeAll(async () => {
  backend = http.createServer(async (req, res) => {
    const raw = await readBody(req)
    backendBodies.push(JSON.parse(raw))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '{"artifact":"evidence-digest.v1","summary":"Endpoint digest","confidence":0.88}',
        },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
      },
    }))
  })
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
  const backendAddr = backend.address() as { port: number }
  backendUrl = `http://127.0.0.1:${backendAddr.port}`

  const config: OwlCodaConfig = {
    port: 0,
    host: '127.0.0.1',
    routerUrl: 'http://127.0.0.1:9999',
    routerTimeoutMs: 5000,
    models: [
      {
        id: 'test-model',
        label: 'Test Model',
        backendModel: 'upstream-model',
        aliases: [],
        tier: 'general',
        default: true,
        endpoint: `${backendUrl}/v1/chat/completions`,
      },
      {
        id: 'prose-only-model',
        label: 'Prose Only Model',
        backendModel: 'prose-only-upstream-model',
        aliases: [],
        tier: 'general',
        endpoint: `${backendUrl}/v1/chat/completions`,
        supportsStructuredOutput: false,
      } as any,
    ],
    responseModelStyle: 'platform',
    catalogLoaded: false,
    modelMap: {},
    defaultModel: '',
    reverseMapInResponse: true,
    logLevel: 'error',
    contextWindow: 32768,
  } as unknown as OwlCodaConfig

  app = startServer(config)
  await new Promise<void>(resolve => app.once('listening', resolve))
  const appAddr = app.address() as { port: number }
  appUrl = `http://127.0.0.1:${appAddr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => app.close(() => resolve()))
  await new Promise<void>(resolve => backend.close(() => resolve()))
})

describe('/v1/structured-output', () => {
  it('routes through the configured model and returns a structured artifact response', async () => {
    const res = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        preset: 'evidence-digest.v1',
        schema: {
          type: 'object',
          required: ['artifact', 'summary', 'confidence'],
          properties: {
            artifact: { const: 'evidence-digest.v1' },
            summary: { type: 'string' },
            confidence: { type: 'number' },
          },
        },
        user: 'Digest this.',
        maxTokens: 500,
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.schemaValid).toBe(true)
    expect(body.artifact).toMatchObject({
      artifact: 'evidence-digest.v1',
      summary: 'Endpoint digest',
      confidence: 0.88,
    })
    expect(body.attempts.map((a: any) => a.label)).toEqual(['primary', 'parse'])
    expect(backendBodies).toHaveLength(1)
    expect(backendBodies[0].model).toBe('upstream-model')
    expect(backendBodies[0].messages[0].role).toBe('system')
    expect(backendBodies[0].messages[0].content).toContain('Return exactly one short JSON object')
    expect(backendBodies[0].messages[0].content).toContain('Required top-level keys: artifact, summary, confidence')
    expect(backendBodies[0].messages[0].content).toContain('Constant fields: artifact="evidence-digest.v1"')
  })

  it('passes caller-provided temperature through to the upstream provider', async () => {
    const beforeCalls = backendBodies.length
    const res = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        preset: 'evidence-digest.v1',
        user: 'Digest this with provider-compatible controls.',
        maxTokens: 256,
        temperature: 1,
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.attempts[0]).toMatchObject({
      requestedTemperature: 1,
      appliedTemperature: 1,
      temperatureSource: 'request',
    })
    expect(backendBodies).toHaveLength(beforeCalls + 1)
    expect(backendBodies.at(-1).temperature).toBe(1)
  })

  it('persists artifact and attempts into the RunWorkspace ledger when requested', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-structured-output-ledger-'))
    try {
      const outputRoot = join(dir, 'run-output')
      await createRunWorkspace({
        outputRoot,
        cwd: dir,
        runId: 'run-structured-output-ledger',
      })

      const beforeCalls = backendBodies.length
      const res = await fetch(`${appUrl}/v1/structured-output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test-model',
          preset: 'evidence-digest.v1',
          schema: {
            type: 'object',
            required: ['artifact', 'summary', 'confidence'],
            properties: {
              artifact: { const: 'evidence-digest.v1' },
              summary: { type: 'string' },
              confidence: { type: 'number' },
            },
          },
          user: 'Digest this and persist it.',
          maxTokens: 500,
          persist: true,
          runRef: outputRoot,
          role: 'evidence',
          threadId: 'thread-structured-output',
          turnId: 'turn-structured-output',
          taskId: 'task-structured-output',
          stepId: 'step-evidence',
        }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.persisted).toBe(true)
      expect(body.artifactId).toMatch(/^structured-output-/)
      expect(body.attemptLedgerId).toBe(`${body.artifactId}-attempts`)
      expect(backendBodies).toHaveLength(beforeCalls + 1)

      const ledger = await readArtifactLedger(outputRoot)
      expect(ledger.artifacts).toHaveLength(2)
      const artifactRecord = ledger.artifacts.find(artifact => artifact.id === body.artifactId)!
      const attemptsRecord = ledger.artifacts.find(artifact => artifact.id === body.attemptLedgerId)!
      expect(artifactRecord).toMatchObject({
        origin: 'model_output_harness',
        artifactType: 'structured_output_artifact',
        threadId: 'thread-structured-output',
        turnId: 'turn-structured-output',
        runId: 'run-structured-output-ledger',
        taskId: 'task-structured-output',
        stepId: 'step-evidence',
        status: 'present',
      })
      expect(attemptsRecord).toMatchObject({
        origin: 'model_output_harness',
        artifactType: 'structured_output_attempts',
        runId: 'run-structured-output-ledger',
        participatesInFinal: false,
        status: 'present',
      })

      const artifactPayload = JSON.parse(await readFile(artifactRecord.path, 'utf8'))
      expect(artifactPayload).toMatchObject({
        version: 1,
        artifactKind: 'structured_output_artifact',
        role: 'evidence',
        model: 'test-model',
        preset: 'evidence-digest.v1',
        ok: true,
        schemaValid: true,
        rawText: '{"artifact":"evidence-digest.v1","summary":"Endpoint digest","confidence":0.88}',
        artifact: {
          artifact: 'evidence-digest.v1',
          summary: 'Endpoint digest',
          confidence: 0.88,
        },
        capabilityGate: {
          ok: true,
          source: 'fallback',
          requestedMaxTokens: 500,
          appliedMaxTokens: 500,
        },
      })
      expect(artifactPayload.requestFingerprint).toMatch(/^sha256:/)
      expect(artifactPayload.schemaHash).toMatch(/^sha256:/)

      const attemptsPayload = JSON.parse(await readFile(attemptsRecord.path, 'utf8'))
      expect(attemptsPayload).toMatchObject({
        version: 1,
        artifactKind: 'structured_output_attempts',
        artifactId: body.artifactId,
        attemptLedgerId: body.attemptLedgerId,
        capabilityGate: {
          ok: true,
          source: 'fallback',
        },
      })
      expect(attemptsPayload.attempts.map((attempt: any) => attempt.label)).toEqual(['primary', 'parse'])

      const eventsText = await readFile(join(outputRoot, '.owlcoda-run', 'events.jsonl'), 'utf8')
      expect(eventsText).toContain('structured_output_artifact_recorded')
      expect(eventsText).toContain(body.artifactId)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects persist=true without runRef before calling upstream', async () => {
    const beforeCalls = backendBodies.length
    const res = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        user: 'Digest this.',
        persist: true,
      }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.message).toContain('runRef is required when persist=true')
    expect(backendBodies).toHaveLength(beforeCalls)
  })

  it('rejects custom presets without an explicit schema before calling upstream', async () => {
    const beforeCalls = backendBodies.length
    const res = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        preset: 'custom-artifact.v1',
        user: 'Digest this.',
      }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.message).toContain('custom preset requires an explicit schema')
    expect(backendBodies).toHaveLength(beforeCalls)
  })

  it('uses model capability routing to reject JSON-unsupported models before calling upstream', async () => {
    const beforeCalls = backendBodies.length
    const res = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'prose-only-model',
        preset: 'evidence-digest.v1',
        user: 'Digest this.',
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.fallbackUsed).toBe(true)
    expect(body.artifact).toMatchObject({
      artifact: 'failed_fallback.v1',
      failureReason: 'capability_json_unsupported',
      model: 'prose-only-model',
    })
    expect(body.capabilityGate).toMatchObject({
      ok: false,
      source: 'declared',
      errors: ['model capability jsonMode=unsupported source=declared'],
    })
    expect(backendBodies).toHaveLength(beforeCalls)
  })

  it('reruns a single role artifact from an inputRef and records lineage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-structured-output-rerun-'))
    try {
      const outputRoot = join(dir, 'run-output')
      await createRunWorkspace({
        outputRoot,
        cwd: dir,
        runId: 'run-structured-output-rerun',
      })

      const first = await fetch(`${appUrl}/v1/structured-output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test-model',
          preset: 'evidence-digest.v1',
          user: 'Original long evidence payload.',
          maxTokens: 500,
          persist: true,
          runRef: outputRoot,
          role: 'evidence',
          threadId: 'thread-rerun',
          turnId: 'turn-original',
          taskId: 'task-rerun',
          stepId: 'step-evidence',
        }),
      })
      expect(first.status).toBe(200)
      const firstBody = await first.json()
      expect(firstBody.artifactId).toMatch(/^structured-output-/)

      const beforeRerunCalls = backendBodies.length
      const rerun = await fetch(`${appUrl}/v1/structured-output/rerun`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test-model',
          preset: 'evidence-digest.v1',
          maxTokens: 500,
          runRef: outputRoot,
          previousArtifactId: firstBody.artifactId,
          inputRef: firstBody.artifactId,
          role: 'evidence',
          threadId: 'thread-rerun',
          turnId: 'turn-rerun',
          taskId: 'task-rerun',
          stepId: 'step-evidence-rerun',
        }),
      })

      expect(rerun.status).toBe(200)
      const rerunBody = await rerun.json()
      expect(rerunBody).toMatchObject({
        ok: true,
        persisted: true,
        rerun: true,
        parentArtifactId: firstBody.artifactId,
        rerunOf: firstBody.artifactId,
      })
      expect(rerunBody.artifactId).toMatch(/^structured-output-/)
      expect(rerunBody.artifactId).not.toBe(firstBody.artifactId)
      expect(rerunBody.attemptLedgerId).toBe(`${rerunBody.artifactId}-attempts`)
      expect(backendBodies).toHaveLength(beforeRerunCalls + 1)
      const rerunUpstreamBody = backendBodies[backendBodies.length - 1]
      expect(JSON.stringify(rerunUpstreamBody.messages)).toContain(firstBody.artifactId)
      expect(JSON.stringify(rerunUpstreamBody.messages)).toContain('Endpoint digest')

      const ledger = await readArtifactLedger(outputRoot)
      expect(ledger.artifacts).toHaveLength(4)
      const rerunRecord = ledger.artifacts.find(artifact => artifact.id === rerunBody.artifactId)!
      const rerunAttemptsRecord = ledger.artifacts.find(artifact => artifact.id === rerunBody.attemptLedgerId)!
      expect(rerunRecord).toMatchObject({
        origin: 'model_output_harness',
        artifactType: 'structured_output_artifact',
        threadId: 'thread-rerun',
        turnId: 'turn-rerun',
        runId: 'run-structured-output-rerun',
        taskId: 'task-rerun',
        stepId: 'step-evidence-rerun',
        status: 'present',
      })
      expect(rerunRecord.factRefs?.coveredIds).toEqual(expect.arrayContaining([firstBody.artifactId]))
      expect(rerunAttemptsRecord).toMatchObject({
        origin: 'model_output_harness',
        artifactType: 'structured_output_attempts',
        participatesInFinal: false,
        status: 'present',
      })
      expect(rerunAttemptsRecord.factRefs?.coveredIds).toEqual(expect.arrayContaining([firstBody.artifactId, rerunBody.artifactId]))

      const rerunPayload = JSON.parse(await readFile(rerunRecord.path, 'utf8'))
      expect(rerunPayload).toMatchObject({
        artifactKind: 'structured_output_artifact',
        role: 'evidence',
        parentArtifactId: firstBody.artifactId,
        rerunOf: firstBody.artifactId,
        inputRef: firstBody.artifactId,
      })
      expect(rerunPayload.factRefs.coveredIds).toEqual(expect.arrayContaining([firstBody.artifactId]))

      const attemptsPayload = JSON.parse(await readFile(rerunAttemptsRecord.path, 'utf8'))
      expect(attemptsPayload).toMatchObject({
        artifactKind: 'structured_output_attempts',
        artifactId: rerunBody.artifactId,
        parentArtifactId: firstBody.artifactId,
        rerunOf: firstBody.artifactId,
      })
      expect(attemptsPayload.attempts.map((attempt: any) => attempt.label)).toEqual(['primary', 'parse'])

      const eventsText = await readFile(join(outputRoot, '.owlcoda-run', 'events.jsonl'), 'utf8')
      expect(eventsText).toContain('structured_output_artifact_rerun_recorded')
      expect(eventsText).toContain(firstBody.artifactId)
      expect(eventsText).toContain(rerunBody.artifactId)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects rerun requests without lineage or input before calling upstream', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-structured-output-rerun-invalid-'))
    try {
      const outputRoot = join(dir, 'run-output')
      await createRunWorkspace({
        outputRoot,
        cwd: dir,
        runId: 'run-structured-output-rerun-invalid',
      })

      const beforeCalls = backendBodies.length
      const missingLineage = await fetch(`${appUrl}/v1/structured-output/rerun`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test-model',
          role: 'evidence',
          runRef: outputRoot,
          inputRef: 'structured-output-missing',
        }),
      })
      expect(missingLineage.status).toBe(400)
      expect((await missingLineage.json()).error.message).toContain('previousArtifactId is required')

      const missingInput = await fetch(`${appUrl}/v1/structured-output/rerun`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test-model',
          role: 'evidence',
          runRef: outputRoot,
          previousArtifactId: 'structured-output-parent',
        }),
      })
      expect(missingInput.status).toBe(400)
      expect((await missingInput.json()).error.message).toContain('user, inputRef, or artifactRef is required')
      expect(backendBodies).toHaveLength(beforeCalls)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
