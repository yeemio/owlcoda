/**
 * Training API endpoint tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handleTraining } from '../src/endpoints/training.js'

let testDir: string
let originalHome: string | undefined

function makeReq(method: string): any {
  return { method }
}

function makeRes(): any {
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    headersSent: false,
    writeHead(code: number, headers?: Record<string, string>) {
      res.statusCode = code
      if (headers) Object.assign(res.headers, headers)
      res.headersSent = true
    },
    end(data?: string) {
      if (data) res.body = data
    },
  }
  return res
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'owlcoda-training-api-'))
  originalHome = process.env.OWLCODA_HOME
  process.env.OWLCODA_HOME = testDir
  await mkdir(join(testDir, 'training'), { recursive: true })
})

afterEach(async () => {
  if (originalHome !== undefined) {
    process.env.OWLCODA_HOME = originalHome
  } else {
    delete process.env.OWLCODA_HOME
  }
  await rm(testDir, { recursive: true, force: true })
})

describe('handleTraining', () => {
  it('returns empty status when no data', async () => {
    const res = makeRes()
    await handleTraining(makeReq('GET'), res, 'status')
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.totalCollected).toBe(0)
  })

  it('returns manifest when data exists', async () => {
    await writeFile(join(testDir, 'training', 'manifest.json'), JSON.stringify({
      totalCollected: 5, totalSkipped: 3, lastCollectedAt: '2025-01-01', averageQuality: 72, qualitySum: 360,
    }))
    await writeFile(join(testDir, 'training', 'collected.jsonl'), '{"messages":[]}\n{"messages":[]}\n')

    const res = makeRes()
    await handleTraining(makeReq('GET'), res, 'status')
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.totalCollected).toBe(5)
    expect(body.lineCount).toBe(2)
  })

  it('clears data on POST', async () => {
    await writeFile(join(testDir, 'training', 'manifest.json'), '{}')
    await writeFile(join(testDir, 'training', 'collected.jsonl'), 'data\n')

    const res = makeRes()
    await handleTraining(makeReq('POST'), res, 'clear')
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).cleared).toBe(true)
  })

  it('rejects GET clear', async () => {
    const res = makeRes()
    await handleTraining(makeReq('GET'), res, 'clear')
    expect(res.statusCode).toBe(405)
  })

  it('exports collected JSONL', async () => {
    const data = '{"messages":[{"role":"user","content":"test"}]}\n'
    await writeFile(join(testDir, 'training', 'collected.jsonl'), data)

    const res = makeRes()
    await handleTraining(makeReq('GET'), res, 'export')
    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toBe('application/x-ndjson')
    expect(res.body).toBe(data)
  })

  it('returns empty for missing export', async () => {
    const res = makeRes()
    await handleTraining(makeReq('GET'), res, 'export')
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('')
  })

  it('rejects unknown action', async () => {
    const res = makeRes()
    await handleTraining(makeReq('GET'), res, 'bogus')
    expect(res.statusCode).toBe(400)
  })
})
