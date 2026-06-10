/**
 * training-store unit tests — runs in-process against a temp OWLCODA_HOME.
 * No spawning, no real ~/.owlcoda touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let testDir: string
let originalHome: string | undefined

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'owlcoda-training-store-'))
  originalHome = process.env.OWLCODA_HOME
  process.env.OWLCODA_HOME = testDir
  await mkdir(join(testDir, 'training'), { recursive: true })
})

afterEach(async () => {
  if (originalHome !== undefined) process.env.OWLCODA_HOME = originalHome
  else delete process.env.OWLCODA_HOME
  await rm(testDir, { recursive: true, force: true })
})

describe('training-store', () => {
  it('returns empty status with manifestPresent=false when nothing exists', async () => {
    const { readCollectedStatus, getCollectedPath } = await import('../src/data/training-store.js')
    const status = await readCollectedStatus()
    expect(status.manifestPresent).toBe(false)
    expect(status.totalCollected).toBe(0)
    expect(status.lineCount).toBe(0)
    expect(status.fileSize).toBe(0)
    expect(status.path).toBe(getCollectedPath())
  })

  it('reads manifest fields and counts JSONL lines', async () => {
    await writeFile(join(testDir, 'training', 'manifest.json'), JSON.stringify({
      totalCollected: 9919,
      totalSkipped: 3066,
      averageQuality: 76,
      lastCollectedAt: '2026-04-23T06:24:16.221Z',
      qualitySum: 753844,
    }))
    await writeFile(join(testDir, 'training', 'collected.jsonl'),
      '{"messages":[{"role":"user","content":"a"}]}\n' +
      '{"messages":[{"role":"user","content":"b"}]}\n' +
      '{"messages":[{"role":"user","content":"c"}]}\n')

    const { readCollectedStatus } = await import('../src/data/training-store.js')
    const status = await readCollectedStatus()
    expect(status.manifestPresent).toBe(true)
    expect(status.totalCollected).toBe(9919)
    expect(status.totalSkipped).toBe(3066)
    expect(status.averageQuality).toBe(76)
    expect(status.lastCollectedAt).toBe('2026-04-23T06:24:16.221Z')
    expect(status.lineCount).toBe(3)
    expect(status.fileSize).toBeGreaterThan(0)
  })

  it('readCollectedLines respects --limit', async () => {
    await writeFile(join(testDir, 'training', 'collected.jsonl'),
      'one\ntwo\nthree\nfour\n')

    const { readCollectedLines } = await import('../src/data/training-store.js')
    const out: string[] = []
    for await (const line of readCollectedLines({ limit: 2 })) out.push(line)
    expect(out).toEqual(['one', 'two'])
  })

  it('readCollectedLines yields nothing when file is missing', async () => {
    const { readCollectedLines } = await import('../src/data/training-store.js')
    const out: string[] = []
    for await (const line of readCollectedLines()) out.push(line)
    expect(out).toEqual([])
  })

  it('readCollectedLines applies sanitizer when requested', async () => {
    // Embedded fake key — sanitizer should redact something OpenAI-shaped.
    const fake = '{"messages":[{"role":"user","content":"key sk-' + 'a'.repeat(40) + ' here"}]}'
    await writeFile(join(testDir, 'training', 'collected.jsonl'), fake + '\n')

    const { readCollectedLines } = await import('../src/data/training-store.js')
    const out: string[] = []
    for await (const line of readCollectedLines({ sanitize: true })) out.push(line)
    expect(out.length).toBe(1)
    expect(out[0]).not.toContain('sk-' + 'a'.repeat(40))
  })

  it('readCollectedSample truncates to maxChars and never exceeds limit', async () => {
    const long = 'x'.repeat(1000)
    await writeFile(join(testDir, 'training', 'collected.jsonl'),
      long + '\n' + long + '\n' + long + '\n')

    const { readCollectedSample } = await import('../src/data/training-store.js')
    const samples = await readCollectedSample({ limit: 2, maxChars: 50, sanitize: false })
    expect(samples.length).toBe(2)
    for (const s of samples) {
      expect(s.raw.length).toBeLessThanOrEqual(50)
      expect(s.truncated).toBe(true)
    }
  })

  it('does not crash on collected entries lacking SessionMeta.messageCount', async () => {
    // The historical export bug came from accessing meta.messageCount on raw
    // collected entries that have no SessionMeta. Confirm the store handles
    // that JSONL shape without exception.
    await writeFile(join(testDir, 'training', 'collected.jsonl'),
      JSON.stringify({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] }) + '\n')
    await writeFile(join(testDir, 'training', 'manifest.json'), JSON.stringify({
      totalCollected: 1, totalSkipped: 0, averageQuality: 80, lastCollectedAt: 'now',
    }))

    const { readCollectedStatus, readCollectedLines } = await import('../src/data/training-store.js')
    const status = await readCollectedStatus()
    expect(status.lineCount).toBe(1)
    const lines: string[] = []
    for await (const l of readCollectedLines({ limit: 5, sanitize: true })) lines.push(l)
    expect(lines.length).toBe(1)
    expect(JSON.parse(lines[0]!).messages.length).toBe(2)
  })
})
