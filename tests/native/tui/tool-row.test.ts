import { describe, expect, it } from 'vitest'
import { renderToolRow } from '../../../src/native/tui/tool-row.js'
import { stripAnsi, visibleWidth } from '../../../src/native/tui/colors.js'

describe('renderToolRow', () => {
  it('renders a compact ok header', () => {
    const result = renderToolRow({
      verb: 'bash',
      arg: 'pnpm build',
      state: 'ok',
      duration: '1.8s',
    })

    expect(stripAnsi(result)).toBe('▸ bash pnpm build  1.8s ✓')
  })

  it('renders run, err, and pending states', () => {
    expect(stripAnsi(renderToolRow({ verb: 'read', arg: 'src/a.ts', state: 'run' }))).toContain('●')
    expect(stripAnsi(renderToolRow({ verb: 'bash', arg: 'exit 1', state: 'err' }))).toContain('✗')
    expect(stripAnsi(renderToolRow({ verb: 'grep', arg: '"todo"', state: 'pending' }))).toContain('·')
  })

  it('renders expanded body lines with indentation', () => {
    const result = renderToolRow({
      verb: 'bash',
      arg: 'pnpm test',
      state: 'run',
      expanded: true,
      bodyLines: ['stdout line', 'stderr line'],
    })
    const lines = stripAnsi(result).split('\n')

    expect(lines[0]).toContain('▾ bash pnpm test')
    expect(lines[1]).toBe('│  stdout line')
    expect(lines[2]).toBe('│  stderr line')
  })

  it('truncates header and body to the visible column budget', () => {
    const result = renderToolRow({
      verb: 'bash',
      arg: 'x'.repeat(80),
      meta: 'in /a/very/long/path',
      state: 'ok',
      duration: '12.0s',
      columns: 32,
      expanded: true,
      bodyLines: ['body-' + 'y'.repeat(80)],
    })

    for (const line of result.split('\n')) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(32)
    }
  })

  it('adds an omitted hint for extra body lines', () => {
    const result = renderToolRow({
      verb: 'grep',
      arg: '"needle"',
      state: 'ok',
      expanded: true,
      maxBodyLines: 2,
      bodyLines: ['match 1', 'match 2', 'match 3', 'match 4'],
    })
    const plain = stripAnsi(result)

    expect(plain).toContain('match 1')
    expect(plain).toContain('match 2')
    expect(plain).not.toContain('match 3')
    expect(plain).toContain('… +2 more lines')
  })
})
