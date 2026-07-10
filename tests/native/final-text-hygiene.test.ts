import { describe, expect, it } from 'vitest'
import { dedupeFinalReportLines } from '../../src/native/final-text-hygiene.js'

describe('final text hygiene', () => {
  it('removes repeated substantial report lines while preserving the first block', () => {
    const line = '- 验证：focused suite 通过，未执行发布动作。'
    expect(dedupeFinalReportLines(`结论\n${line}\n\n${line}`)).toBe(`结论\n${line}\n`)
  })

  it('does not collapse short structural labels', () => {
    expect(dedupeFinalReportLines('结果\n结果\nA\nA')).toBe('结果\n结果\nA\nA')
  })
})
