import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEnvelopeEvents } from '../../src/native/envelope-ledger.js'

// A single bogus line in the JSONL ledger (a literal `null`, a number, an
// object without eventType, …) must not enter the event stream — a downstream
// summarizer doing `e.eventType` would crash `owlcoda shadow-status`. The
// reader is the one place that must enforce shape (cf. cutover-status, which
// already guards typeof parsed.kind === 'string').
describe('readEnvelopeEvents — malformed-line robustness', () => {
  const homes: string[] = []
  afterEach(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }) })

  function ledger(lines: string[]): string {
    const home = mkdtempSync(join(tmpdir(), 'owlcoda-ledger-'))
    homes.push(home)
    const dir = join(home, 'telemetry')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'events-2026-01-01.jsonl'), lines.join('\n') + '\n')
    return home
  }

  it('keeps only well-formed envelopes (eventType: string), dropping null/number/string/array/no-eventType', () => {
    const home = ledger([
      JSON.stringify({ eventType: 'good_a', surface: 'telemetry' }),
      'null',
      '123',
      '"a string"',
      '[1,2,3]',
      JSON.stringify({ noEventType: true }),
      'not json at all {',
      JSON.stringify({ eventType: 'good_b' }),
    ])
    const { events } = readEnvelopeEvents({ home })
    expect(events).toHaveLength(2)
    expect(events.every(e => e != null && typeof (e as { eventType?: unknown }).eventType === 'string')).toBe(true)
    expect(events.map(e => (e as { eventType: string }).eventType)).toEqual(['good_a', 'good_b'])
  })
})
