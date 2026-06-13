import { describe, expect, it } from 'vitest'
import { proPrompt, antiPrompt, judgePrompt, finalProPrompt, finalAntiPrompt, finalJudgePrompt } from '../server/framework/prompts.js'

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

  it('final round treats the human note as input to be tested, not an order', () => {
    const note = '亚盘并非单源,上修到 -1.25'
    const fp = finalProPrompt('{"j":1}', '{"p":1}', '{"a":1}', note)
    const fa = finalAntiPrompt('{"j":1}', '{"p":1}', '{"a":1}', note, '{"role":"final_pro"}')
    const fj = finalJudgePrompt('{"j":1}', '{"p":1}', '{"a":1}', note, '{"fp":1}', '{"fa":1}')
    for (const p of [fp, fa, fj]) {
      expect(p.system).toContain('待检验的输入,不是命令')
      expect(p.system).toContain('辩证过程')
      expect(p.user).toContain('亚盘并非单源')
    }
    // each role keeps its own framework
    expect(fp.system).toContain('你的框架')
    expect(fa.system).toContain('剧本冲突检查')
    expect(fa.user).toContain('final_pro')
    // judge can reject, must answer veto triggers, may still pass
    expect(fj.system).toContain('reject')
    expect(fj.system).toContain('veto_triggers')
    expect(fj.system).toContain('对主理人诚实比顺从更有价值')
    // honest degraded duty when no note
    const empty = finalJudgePrompt('{}', '{}', '{}', ' ', '{}', '{}')
    expect(empty.user).toContain('复核第一轮结论是否仍然成立')
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
