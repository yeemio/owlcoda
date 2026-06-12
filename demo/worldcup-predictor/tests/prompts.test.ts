import { describe, expect, it } from 'vitest'
import { proPrompt, antiPrompt, judgePrompt } from '../server/framework/prompts.js'

const brief = '# Debate Evidence | A vs B'

describe('role prompts (ported from hermes-football)', () => {
  it('pro keeps anti-fabrication rules and opportunity-cost duty', () => {
    const p = proPrompt(brief)
    expect(p.system).toContain('严禁编造')
    expect(p.system).toContain('机会侦察官')
    expect(p.system).toContain('机会成本')
    expect(p.system).toContain('"role": "pro"')
    expect(p.user).toContain(brief)
  })

  it('anti receives pro output and must counter point by point', () => {
    const p = antiPrompt(brief, '{"role":"pro"}')
    expect(p.system).toContain('counter_to_pro')
    expect(p.system).toContain('风控')
    expect(p.user).toContain('{"role":"pro"}')
  })

  it('judge keeps hard gates: directional score rules, anti veto, freshness', () => {
    const p = judgePrompt(brief, '{"role":"pro"}', '{"role":"anti"}')
    expect(p.system).toContain('directional_score')
    expect(p.system).toContain('50=完全五五开')
    expect(p.system).toContain('risk_veto_assessment')
    expect(p.system).toContain('evidence_freshness_verdict')
    expect(p.system).toContain('anti_direction_case')
    expect(p.system).toContain('win_probabilities')
    expect(p.user).toContain('{"role":"anti"}')
  })

  it('judge carries the owner decision doctrine (2026-06-12 calibration)', () => {
    const p = judgePrompt(brief, '{}', '{}')
    expect(p.system).toContain('盘口来源核验')
    expect(p.system).toContain('剧本冲突')
    expect(p.system).toContain('赢球但盘口难受')
    expect(p.system).toContain('优先级排序')
    expect(antiPrompt(brief, '{}').system).toContain('互相打架')
    expect(proPrompt(brief).system).toContain('比分剧本')
  })
})
