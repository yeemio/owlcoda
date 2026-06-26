import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { loadConfig } from '../src/config.js'
import { startServer } from '../src/server.js'

type Json = Record<string, unknown>

const artifactSchema = {
  type: 'object',
  required: ['artifact', 'summary', 'confidence'],
  properties: {
    artifact: { const: 'evidence-digest.v1' },
    summary: { type: 'string' },
    confidence: { type: 'number' },
    source_refs: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: true,
}

function fail(message: string): never {
  throw new Error(message)
}

function asObject(value: unknown, label: string): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }
  return value as Json
}

function attemptLabels(body: Json): string[] {
  const attempts = Array.isArray(body['attempts']) ? body['attempts'] : []
  return attempts.map(attempt => asObject(attempt, 'attempt').label).filter((label): label is string => typeof label === 'string')
}

function expectStructuredSuccess(body: Json): void {
  if (body['ok'] !== true) fail('success response ok must be true')
  if (body['schemaValid'] !== true) fail('success response schemaValid must be true')
  const artifact = asObject(body['artifact'], 'success artifact')
  if (artifact['artifact'] !== 'evidence-digest.v1') fail('success artifact must be evidence-digest.v1')
  if (typeof body['rawText'] !== 'string' || body['rawText'].trim() === '') fail('success rawText must be non-empty')
  const labels = attemptLabels(body)
  if (!labels.includes('primary')) fail('success attempts must include primary')
  if (!labels.some(label => label === 'parse' || label === 'repair' || label === 'salvage')) {
    fail('success attempts must include parse, repair, or salvage')
  }
}

function expectStructuredFallback(body: Json): void {
  if (body['ok'] !== false) fail('fallback response ok must be false')
  const artifact = asObject(body['artifact'], 'fallback artifact')
  if (artifact['artifact'] !== 'failed_fallback.v1') fail('fallback artifact must be failed_fallback.v1')
  if (artifact['retryHint'] !== 'rerun_role_artifact') fail('fallback retryHint must be rerun_role_artifact')
  const labels = attemptLabels(body)
  if (!labels.includes('fallback')) fail('fallback attempts must include fallback')
}

function waitForListening(server: Server): Promise<void> {
  if (server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()))
}

async function postStructured(baseUrl: string, body: Json): Promise<Json> {
  const res = await fetch(`${baseUrl}/v1/structured-output`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json() as unknown
  if (res.status !== 200) {
    fail(`structured-output HTTP ${res.status}: ${JSON.stringify(json).slice(0, 500)}`)
  }
  return asObject(json, 'structured-output response')
}

async function main(): Promise<void> {
  const configPath = process.env['OWLCODA_STRUCTURED_OUTPUT_SMOKE_CONFIG']
  const model = process.env['OWLCODA_STRUCTURED_OUTPUT_SMOKE_MODEL'] ?? 'kimi-code'
  const outDir = process.env['OWLCODA_STRUCTURED_OUTPUT_SMOKE_OUT'] ?? '.tmp/release-structured-output-smoke'
  const config = loadConfig(configPath)
  const server = startServer({
    ...config,
    host: '127.0.0.1',
    port: 0,
    logLevel: 'error',
  })

  try {
    await waitForListening(server)
    const address = server.address()
    if (!address || typeof address === 'string') fail('server did not bind a TCP port')
    const baseUrl = `http://127.0.0.1:${address.port}`
    mkdirSync(outDir, { recursive: true })

    const success = await postStructured(baseUrl, {
      model,
      preset: 'evidence-digest.v1',
      schema: artifactSchema,
      user: [
        'Produce one compact evidence digest JSON object for OwlFootball release smoke.',
        'Use artifact exactly evidence-digest.v1.',
        'Use summary "OwlFootball structured output smoke passed".',
        'Use confidence 0.72.',
      ].join('\n'),
      maxTokens: 700,
      repairPolicy: { enabled: true, maxAttempts: 1 },
      salvagePolicy: { enabled: true, fields: ['artifact', 'summary', 'confidence', 'source_refs', 'risks'] },
    })
    writeFileSync(join(outDir, 'success.json'), `${JSON.stringify(success, null, 2)}\n`)
    expectStructuredSuccess(success)

    const fallback = await postStructured(baseUrl, {
      model,
      preset: 'evidence-digest.v1',
      schema: artifactSchema,
      user: [
        'Produce one compact evidence digest JSON object for a policy fallback smoke.',
        'Use artifact exactly evidence-digest.v1 and any short summary.',
      ].join('\n'),
      maxTokens: 700,
      policy: { forbiddenPhrases: ['evidence-digest.v1'] },
    })
    writeFileSync(join(outDir, 'fallback.json'), `${JSON.stringify(fallback, null, 2)}\n`)
    expectStructuredFallback(fallback)

    console.log(JSON.stringify({
      ok: true,
      model,
      baseUrl,
      successAttempts: attemptLabels(success),
      fallbackAttempts: attemptLabels(fallback),
      outDir,
    }, null, 2))
  } finally {
    await closeServer(server)
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
})
