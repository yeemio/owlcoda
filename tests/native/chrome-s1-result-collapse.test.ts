import { describe, expect, it } from 'vitest'
import {
  collapseResultBody,
  foldLine,
  parseBashPayload,
} from '../../src/native/tui/chrome.js'
import { formatToolResult } from '../../src/native/tui/message.js'

// Transcript Chrome Spec S1 (docs/superpowers/specs/2026-06-11-transcript-
// chrome-spec-design.md): human display ≠ model payload. The bash protocol
// labels ([stdout]/[stderr]/[exit code: N]) never reach the human view;
// result bodies collapse (ok: head, err: tail) behind a constant-shape fold
// line; errors render the SAME shape as success with swapped accent — the
// ╴╴╴ banner + ▎ rail family is retired.

const ANSI_RE = /\x1b\[[0-9;]*m/g
const strip = (s: string): string => s.replace(ANSI_RE, '')

// Real-shape payload as produced by formatBashOutput (bash.ts).
const OK_PAYLOAD = [
  '[stdout]',
  'line one',
  'line two',
  'line three',
  'line four',
  'line five',
  'line six',
  'line seven',
  '',
  '[exit code: 0]',
].join('\n')

const ERR_PAYLOAD = [
  '[stdout]',
  ...Array.from({ length: 20 }, (_, i) => `setup step ${i + 1}`),
  '',
  '[stderr]',
  'Error response from daemon: No such container: openclaw-gateperl',
  '',
  '[exit code: 1]',
].join('\n')

describe('parseBashPayload — model payload → display payload', () => {
  it('strips section labels and extracts exit code', () => {
    const parsed = parseBashPayload(OK_PAYLOAD)
    expect(parsed).not.toBeNull()
    expect(parsed!.exitCode).toBe(0)
    expect(parsed!.killed).toBe(false)
    expect(parsed!.lines[0]).toBe('line one')
    expect(parsed!.lines).not.toContain('[stdout]')
    expect(parsed!.lines.join('\n')).not.toContain('[exit code:')
  })

  it('merges stdout and stderr lines in order', () => {
    const parsed = parseBashPayload(ERR_PAYLOAD)!
    expect(parsed.exitCode).toBe(1)
    expect(parsed.lines[0]).toBe('setup step 1')
    expect(parsed.lines.at(-1)).toContain('No such container')
    expect(parsed.lines.join('\n')).not.toContain('[stderr]')
  })

  it('detects the killed marker', () => {
    const payload = '[stdout]\npartial\n\n[killed] Process timed out after 5000ms\n[exit code: 124]'
    const parsed = parseBashPayload(payload)!
    expect(parsed.killed).toBe(true)
    expect(parsed.exitCode).toBe(124)
    expect(parsed.lines.join('\n')).not.toContain('[killed]')
  })

  it('handles the empty-output trailer-only payload', () => {
    const parsed = parseBashPayload('[exit code: 0]')!
    expect(parsed.lines).toEqual([])
    expect(parsed.exitCode).toBe(0)
  })

  it('returns null for non-protocol text', () => {
    expect(parseBashPayload('plain tool output without protocol')).toBeNull()
  })
})

describe('collapseResultBody + foldLine — constant-shape folding', () => {
  it('ok results keep the head', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `l${i + 1}`)
    const { shown, hidden, fromTail } = collapseResultBody(lines, { isError: false, budget: 5 })
    expect(shown).toEqual(['l1', 'l2', 'l3', 'l4', 'l5'])
    expect(hidden).toBe(7)
    expect(fromTail).toBe(false)
  })

  it('error results keep the tail (errors live at the end)', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i + 1}`)
    const { shown, hidden, fromTail } = collapseResultBody(lines, { isError: true, budget: 10 })
    expect(shown.at(-1)).toBe('l30')
    expect(shown).toHaveLength(10)
    expect(hidden).toBe(20)
    expect(fromTail).toBe(true)
  })

  it('does not fold when within budget', () => {
    const lines = ['a', 'b']
    const { shown, hidden } = collapseResultBody(lines, { isError: false, budget: 5 })
    expect(shown).toEqual(lines)
    expect(hidden).toBe(0)
  })

  it('fold line shape is constant: "… +N lines · meta"', () => {
    expect(strip(foldLine(47, 'exit 0'))).toBe('… +47 lines · exit 0')
    expect(strip(foldLine(3))).toBe('… +3 lines')
  })
})

describe('formatToolResult — S1 integration', () => {
  it('bash ok: labels gone, head ≤5 lines, fold carries exit code', () => {
    const out = strip(formatToolResult('bash', OK_PAYLOAD, false, 3400))
    expect(out).not.toContain('[stdout]')
    expect(out).not.toContain('[exit code:')
    expect(out).toContain('✓')
    expect(out).toContain('line five')
    expect(out).not.toContain('line six')
    expect(out).toMatch(/… \+2 lines · exit 0/)
  })

  it('bash err: same shape as ok (⎿ gutter, no ╴ family), tail shown, exit in fold', () => {
    const out = strip(formatToolResult('bash', ERR_PAYLOAD, true, 3000))
    expect(out).toContain('✗')
    expect(out).toContain('⎿')
    expect(out).not.toContain('╴')
    expect(out).toContain('No such container')
    expect(out).not.toContain('setup step 1\n')
    expect(out).toMatch(/… \+\d+ lines · exit 1/)
  })

  it('non-bash ok: head 3 + bare fold line', () => {
    const out = strip(formatToolResult('grep', 'm1\nm2\nm3\nm4\nm5\nm6', false, 120))
    expect(out).toContain('m3')
    expect(out).not.toContain('m4')
    expect(out).toMatch(/… \+3 lines/)
    expect(out).not.toMatch(/… \+3 lines ·/)
  })

  it('fast validation error stays a compact single line, unified gutter', () => {
    const out = strip(formatToolResult('bash', 'steps must be a non-empty array', true, 5))
    expect(out.split('\n')).toHaveLength(1)
    expect(out).toContain('✗')
    expect(out).toContain('— steps must be a non-empty array')
    expect(out).not.toContain('╴')
  })

  it('discipline lock: no rendering path emits the retired ╴ rule glyph', () => {
    const cases = [
      formatToolResult('bash', ERR_PAYLOAD, true, 9000),
      formatToolResult('read', 'x'.repeat(2000), true, 800),
      formatToolResult('bash', OK_PAYLOAD, false, 10),
    ]
    for (const c of cases) expect(strip(c)).not.toContain('╴')
  })
})
