import { describe, expect, it } from 'vitest'
import { findInkSideChannelWrites } from '../scripts/ink-write-boundary.mjs'

describe('findInkSideChannelWrites', () => {
  it('flags an effect-hook write in a .ts file using angle-bracket type assertion', () => {
    const src = [
      'function C() {',
      '  useEffect(() => {',
      '    const y = <Foo>bar',
      "    process.stdout.write('x')",
      '  }, [])',
      '}',
    ].join('\n')
    // Under the TSX dialect <Foo>bar parses as JSX and swallows the write — the
    // gate must parse .ts as TS so this real side-channel write is still caught.
    expect(findInkSideChannelWrites(src, 'c.ts')).toHaveLength(1)
  })

  it('flags a stdout.write inside a useLayoutEffect callback', () => {
    const src = [
      'function C() {',
      '  useLayoutEffect(() => {',
      "    terminal.stdout.write('x')",
      '  }, [])',
      '}',
    ].join('\n')
    const hits = findInkSideChannelWrites(src, 'C.tsx')
    expect(hits.map(h => h.line)).toEqual([3])
  })

  it('flags a stdout.write inside a useEffect callback', () => {
    const src = [
      'function C() {',
      '  useEffect(() => {',
      "    process.stdout.write('y')",
      '  })',
      '}',
    ].join('\n')
    expect(findInkSideChannelWrites(src, 'C.tsx')).toHaveLength(1)
  })

  it('does NOT flag stdout.write outside any effect (the legit renderer path)', () => {
    const src = [
      'class Renderer {',
      '  flush(buf: string) {',
      '    this.options.stdout.write(buf)',
      '  }',
      '}',
    ].join('\n')
    expect(findInkSideChannelWrites(src, 'r.tsx')).toEqual([])
  })

  it('does NOT flag a non-stdout write inside an effect', () => {
    const src = [
      'function C() {',
      '  useEffect(() => {',
      "    file.write('z')",
      '  }, [])',
      '}',
    ].join('\n')
    expect(findInkSideChannelWrites(src, 'C.tsx')).toEqual([])
  })

  it('matches stdout.write through a property chain inside an effect', () => {
    const src = [
      'function C() {',
      '  useLayoutEffect(() => {',
      "    this.props.stdout.write('chain')",
      '  }, [])',
      '}',
    ].join('\n')
    expect(findInkSideChannelWrites(src, 'C.tsx')).toHaveLength(1)
  })

  it('returns an empty array for source with no effects', () => {
    expect(findInkSideChannelWrites('export const x = 1', 'x.ts')).toEqual([])
  })
})
