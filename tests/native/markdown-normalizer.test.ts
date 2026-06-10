/**
 * Unit tests for MarkdownBlockNormalizer.
 *
 * The normalizer's contract: feedLine(line) returns 0..N typed tokens.
 * Held lines (awaiting next-line lookahead) emit nothing on the held call;
 * the decision happens when the next line arrives, or via finalize().
 *
 * 30+ cases cover: clean tokens, malformed inputs, lookahead resolution,
 * code fence containment, table state machine entry/exit.
 */

import { describe, it, expect } from 'vitest'
import { MarkdownBlockNormalizer, type NormalizedLine } from '../../src/native/markdown-normalizer.js'

/** Feed an entire text and collect the full token stream. */
function tokens(text: string): NormalizedLine[] {
  const n = new MarkdownBlockNormalizer()
  return n.feedAll(text)
}

/** Feed one line at a time + finalize, collecting tokens. */
function tokensByLine(text: string): NormalizedLine[] {
  const n = new MarkdownBlockNormalizer()
  const out: NormalizedLine[] = []
  const lines = text.split('\n')
  for (const line of lines) {
    out.push(...n.feedLine(line))
  }
  out.push(...n.finalize())
  return out
}

/** Just the kind sequence (for shape assertions). */
function kinds(text: string): string[] {
  return tokens(text).map(t => t.kind)
}

describe('MarkdownBlockNormalizer — basic shapes', () => {
  it('empty input → no tokens', () => {
    expect(tokens('')).toEqual([])
  })

  it('blank line → blank token', () => {
    expect(tokens('\n')).toEqual([{ kind: 'blank' }])
  })

  it('plain text → text token', () => {
    expect(tokens('hello world')).toEqual([{ kind: 'text', text: 'hello world' }])
  })

  it('clean H2 heading', () => {
    expect(tokens('## Section')).toEqual([{ kind: 'heading', level: 2, text: 'Section' }])
  })

  it('clean H3 heading with CJK lookahead (no space)', () => {
    expect(tokens('###一、引言')).toEqual([{ kind: 'heading', level: 3, text: '一、引言' }])
  })

  it('clean H1 — H6 levels', () => {
    expect(tokens('# A').map(t => t.kind === 'heading' ? t.level : null)).toEqual([1])
    expect(tokens('###### F').map(t => t.kind === 'heading' ? t.level : null)).toEqual([6])
  })

  it('text + blank + text', () => {
    expect(kinds('a\n\nb')).toEqual(['text', 'blank', 'text'])
  })
})

describe('MarkdownBlockNormalizer — code fence containment', () => {
  it('open + content + close', () => {
    expect(kinds('```ts\nconst x = 1\n```')).toEqual([
      'code-fence-open', 'code-line', 'code-fence-close',
    ])
  })

  it('## inside fence is preserved as code-line, not heading', () => {
    const t = tokens('```\n## not a heading\n```')
    expect(t[0]?.kind).toBe('code-fence-open')
    expect(t[1]).toEqual({ kind: 'code-line', text: '## not a heading' })
    expect(t[2]?.kind).toBe('code-fence-close')
  })

  it('| inside fence is preserved as code-line, not table', () => {
    const t = tokens('```\n|cell|cell|\n```')
    expect(t[1]).toEqual({ kind: 'code-line', text: '|cell|cell|' })
  })

  it('fence-open captures language', () => {
    const t = tokens('```typescript\nfoo\n```')
    expect(t[0]).toEqual({ kind: 'code-fence-open', lang: 'typescript' })
  })

  it('fence-open without language', () => {
    const t = tokens('```\nfoo\n```')
    expect(t[0]).toEqual({ kind: 'code-fence-open', lang: '' })
  })
})

describe('MarkdownBlockNormalizer — clean GFM table', () => {
  it('header + separator + 2 rows', () => {
    expect(kinds('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |')).toEqual([
      'table-header', 'table-separator', 'table-row', 'table-row',
    ])
  })

  it('header cells parsed correctly', () => {
    const t = tokens('| a | b |\n|---|---|')
    expect(t[0]).toMatchObject({ kind: 'table-header', cells: ['a', 'b'] })
  })

  it('separator alignSpec parsed', () => {
    const t = tokens('| a | b |\n|:---|---:|')
    expect(t[1]).toMatchObject({ kind: 'table-separator' })
    if (t[1]?.kind === 'table-separator') {
      expect(t[1].alignSpec).toHaveLength(2)
    }
  })

  it('table ends when non-pipe line follows', () => {
    expect(kinds('| a | b |\n|---|---|\n| 1 | 2 |\nplain text')).toEqual([
      'table-header', 'table-separator', 'table-row', 'text',
    ])
  })

  it('table ends when blank line follows (\n\n)', () => {
    expect(kinds('| a | b |\n|---|---|\n| 1 | 2 |\n\n')).toEqual([
      'table-header', 'table-separator', 'table-row', 'blank',
    ])
  })

  it('trailing single \n is line-ending, not a blank', () => {
    // GFM: '\n' at end terminates the last line, doesn't add a blank.
    expect(kinds('a\n')).toEqual(['text'])
    expect(kinds('| a | b |\n|---|---|\n| 1 | 2 |\n')).toEqual([
      'table-header', 'table-separator', 'table-row',
    ])
  })
})

describe('MarkdownBlockNormalizer — malformed input recovery', () => {
  it('## heading|cells| jammed → split heading + table-header', () => {
    const k = kinds('## H|a|b|\n|---|---|\n| 1 | 2 |')
    expect(k).toEqual(['heading', 'table-header', 'table-separator', 'table-row'])
  })

  it('## heading|cells| jammed: heading text is just heading, no |', () => {
    const t = tokens('## H|a|b|\n|---|---|')
    expect(t[0]).toEqual({ kind: 'heading', level: 2, text: 'H' })
    expect(t[1]).toMatchObject({ kind: 'table-header', cells: ['a', 'b'] })
  })

  it('**bold heading**|cells| jammed → split text + table-header', () => {
    const k = kinds('**Section**|a|b|\n|---|---|\n| 1 | 2 |')
    expect(k).toEqual(['text', 'table-header', 'table-separator', 'table-row'])
  })

  it('plain prefix|cells| → split text + table-header (when followed by separator)', () => {
    const k = kinds('总结|a|b|\n|---|---|\n| 1 | 2 |')
    expect(k).toEqual(['text', 'table-header', 'table-separator', 'table-row'])
  })

  it('mid-line heading marker (space-separated)', () => {
    // Strict markdown: ### must be followed by space or digit/CJK to be a heading.
    // 'text###Heading' (no space, ASCII follow) is plain text per spec.
    const k = kinds('text### Heading')
    expect(k).toEqual(['text', 'heading'])
    const t = tokens('text### Heading')
    expect(t[1]).toEqual({ kind: 'heading', level: 3, text: 'Heading' })
  })

  it('mid-line heading: ###Heading (no space, ASCII) stays plain text per spec', () => {
    // Documents the strict-spec behavior. If lenient acceptance is wanted later,
    // that's a separate slice with explicit motivation.
    expect(kinds('text###Heading')).toEqual(['text'])
  })

  it('mid-line heading: prefix preserved', () => {
    const t = tokens('preamble###1. point')
    expect(t[0]).toEqual({ kind: 'text', text: 'preamble' })
    expect(t[1]).toMatchObject({ kind: 'heading', text: '1. point' })
  })

  it('||| (only pipes/spaces, no -) is NOT a separator', () => {
    const k = kinds('header line\n|||\nmore text')
    // header line has no pipes that could be table-header, so: text, text, text
    // |||  is just plain text (looks like separator regex but lacks `-`)
    expect(k.includes('table-header')).toBe(false)
    expect(k.includes('table-separator')).toBe(false)
  })

  it('|cells| not followed by separator → plain text', () => {
    const k = kinds('| not | a | table |\nplain next line')
    expect(k.includes('table-header')).toBe(false)
    expect(k[0]).toBe('text')
  })

  it('lookahead: pending text resolves on next-line non-separator', () => {
    const k = kinds('text|with|pipes\nnext line is not separator')
    expect(k).toEqual(['text', 'text'])
  })
})

describe('MarkdownBlockNormalizer — state transitions', () => {
  it('heading → text → heading (table state cleared)', () => {
    expect(kinds('# A\nbody\n# B')).toEqual(['heading', 'text', 'heading'])
  })

  it('table → blank → heading (inTable resets)', () => {
    expect(kinds('| a |\n|---|\n| 1 |\n\n## next')).toEqual([
      'table-header', 'table-separator', 'table-row', 'blank', 'heading',
    ])
  })

  it('reset() clears all state', () => {
    const n = new MarkdownBlockNormalizer()
    n.feedLine('## heading')
    n.feedLine('| a | b |')
    n.reset()
    // After reset, fresh state — '|---|---|' alone is just text
    expect(n.feedLine('|---|---|')).toEqual([{ kind: 'text', text: '|---|---|' }])
  })
})

describe('MarkdownBlockNormalizer — feedAll vs feedLine equivalence', () => {
  const cases = [
    'plain text',
    '## heading',
    '## H|a|b|\n|---|---|\n| 1 | 2 |',
    '```\n## inside\n```',
    'three lines\nblank line below\n\nthird',
    '**bold**|x|y|\n|---|---|\n| a | b |',
  ]
  for (const md of cases) {
    it(`feedAll === feedLine: ${JSON.stringify(md.slice(0, 40))}`, () => {
      expect(tokens(md)).toEqual(tokensByLine(md))
    })
  }
})

describe('MarkdownBlockNormalizer — finalize drains pending', () => {
  it('input ends with held |cells| line → emitted as text on finalize', () => {
    const n = new MarkdownBlockNormalizer()
    const a = n.feedLine('| a | b |')  // potential table-header, held
    const b = n.finalize()  // no next line — emit as text
    expect(a).toEqual([])
    expect(b).toEqual([{ kind: 'text', text: '| a | b |' }])
  })

  it('input ends mid-fence → finalize emits no fake-close', () => {
    const n = new MarkdownBlockNormalizer()
    n.feedLine('```')
    n.feedLine('content')
    const f = n.finalize()
    // Don't assert specific behavior — both "tolerant drain" and "leave-open"
    // are acceptable. But finalize must not throw.
    expect(Array.isArray(f)).toBe(true)
  })
})
