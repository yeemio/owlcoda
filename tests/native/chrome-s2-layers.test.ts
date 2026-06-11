import { describe, expect, it } from 'vitest'
import { renderNarration } from '../../src/native/tui/chrome.js'
import { formatToolGroup } from '../../src/native/tui/message.js'
import { stripAnsi, visibleWidth } from '../../src/native/tui/colors.js'

// Chrome spec S2 — layer rebuild:
//  - narration (what the model says) gets its own ● gutter; ⎿ goes back to
//    meaning "output of the action above" exclusively
//  - action + result commit as ONE group on completion (▸ verb arg ✓ dur
//    header + ⎿ body), retiring the duplicated "▸ Bash cmd ●" +
//    "⎿ ✓ Bash (3.4s)" pair
//  - narration lines are wrapped by the chrome layer with a hanging indent
//    so terminal hard-wrap never produces col-0 continuation rows

describe('renderNarration — ● gutter + hanging indent', () => {
  it('first line gets the ● gutter, following logical lines indent', () => {
    const out = stripAnsi(renderNarration('找到了。\n对比两条请求。', { firstBlock: true, columns: 80 }))
    const lines = out.split('\n')
    expect(lines[0]).toBe('● 找到了。')
    expect(lines[1]).toBe('  对比两条请求。')
  })

  it('continuation blocks (after the header was shown) indent without ●', () => {
    const out = stripAnsi(renderNarration('继续说。', { firstBlock: false, columns: 80 }))
    expect(out).toBe('  继续说。')
  })

  it('wraps long CJK lines with a hanging indent — no col-0 continuations', () => {
    const long = '这是一段足够长的中文叙述用来验证悬挂缩进折行不再把续行顶到第零列造成对齐崩坏的问题。'
    const out = stripAnsi(renderNarration(long, { firstBlock: true, columns: 40 }))
    const lines = out.split('\n')
    expect(lines.length).toBeGreaterThan(1)
    expect(lines[0]!.startsWith('● ')).toBe(true)
    for (const line of lines.slice(1)) {
      expect(line.startsWith('  ')).toBe(true)
      expect(line[2]).not.toBe(' ')
    }
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40)
    }
  })

  it('preserves the trailing-empty-segment convention of the streaming caller', () => {
    // The streaming path splits on \n and the final '' segment must stay ''
    // so chunk concatenation in liveResponseRef keeps line boundaries.
    const out = renderNarration('一行完成\n', { firstBlock: true, columns: 80 })
    expect(out.endsWith('\n')).toBe(true)
  })
})

describe('formatToolGroup — merged action+result block', () => {
  const OK_PAYLOAD = [
    '[stdout]',
    ...Array.from({ length: 9 }, (_, i) => `log line ${i + 1}`),
    '',
    '[exit code: 0]',
  ].join('\n')

  it('one header row: ▸ verb arg … ✓ duration (no second ⎿ ✓ header)', () => {
    const out = stripAnsi(formatToolGroup('bash', { command: 'docker logs openclaw-gateway' }, OK_PAYLOAD, false, 3400))
    const lines = out.split('\n')
    expect(lines[0]).toContain('▸')
    expect(lines[0]).toContain('Bash')
    expect(lines[0]).toContain('docker logs openclaw-gateway')
    expect(lines[0]).toContain('✓')
    expect(lines[0]).toContain('3.4s')
    // Exactly one status glyph in the whole block — header carries it.
    expect(out.match(/✓/g)).toHaveLength(1)
  })

  it('body rides under ⎿ with aligned continuation and the constant fold line', () => {
    const out = stripAnsi(formatToolGroup('bash', { command: 'x' }, OK_PAYLOAD, false, 3400))
    const lines = out.split('\n')
    expect(lines[1]).toMatch(/^ {2}⎿ log line 1/)
    expect(lines[2]).toMatch(/^ {4}log line 2/)
    expect(out).toMatch(/… \+4 lines · exit 0/)
  })

  it('errors are the same shape with ✗ — tail body, no ╴ family', () => {
    const errPayload = '[stdout]\n' + Array.from({ length: 20 }, (_, i) => `step ${i + 1}`).join('\n')
      + '\n\n[stderr]\nNo such container\n\n[exit code: 1]'
    const out = stripAnsi(formatToolGroup('bash', { command: 'docker exec' }, errPayload, true, 3200))
    const lines = out.split('\n')
    expect(lines[0]).toContain('✗')
    expect(out).toContain('No such container')
    expect(out).not.toContain('╴')
    expect(out).toMatch(/… \+\d+ lines · exit 1/)
  })

  it('empty output keeps just the header row', () => {
    const out = stripAnsi(formatToolGroup('bash', { command: 'true' }, '[exit code: 0]', false, 90))
    expect(out.split('\n')).toHaveLength(1)
    expect(out).toContain('✓')
  })
})
