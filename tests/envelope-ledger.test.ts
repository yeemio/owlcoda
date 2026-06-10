import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEnvelopeEvents } from '../src/native/envelope-ledger.js'

describe('readEnvelopeEvents', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'owlcoda-envledger-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function tel(): string {
    const t = join(dir, 'telemetry')
    mkdirSync(t, { recursive: true })
    return t
  }

  it('reads events-*.jsonl, tolerates malformed lines, and ignores other files', () => {
    const t = tel()
    writeFileSync(join(t, 'gate-events-2026-06-06.jsonl'), '{"kind":"x"}\n') // wrong prefix → ignored
    writeFileSync(join(t, 'events-2026-06-06.jsonl'), '{"eventType":"a"}\nbad json\n{"eventType":"b"}\n')
    const { events, filesRead } = readEnvelopeEvents({ home: dir })
    expect(events.map(e => (e as { eventType?: string }).eventType)).toEqual(['a', 'b'])
    expect(filesRead.length).toBe(1)
  })

  it('returns empty when the telemetry dir is missing', () => {
    expect(readEnvelopeEvents({ home: dir }).events).toEqual([])
  })

  it('honors maxFiles (reads the most recent file only when maxFiles=1)', () => {
    const t = tel()
    writeFileSync(join(t, 'events-2026-06-05.jsonl'), '{"eventType":"old"}\n')
    writeFileSync(join(t, 'events-2026-06-06.jsonl'), '{"eventType":"new"}\n')
    const { events } = readEnvelopeEvents({ home: dir, maxFiles: 1 })
    expect(events.map(e => (e as { eventType?: string }).eventType)).toEqual(['new'])
  })
})
