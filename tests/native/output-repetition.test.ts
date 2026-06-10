import { describe, it, expect } from 'vitest'
import {
  detectOutputRepetition,
  isOutputRepetitionShadowEnabled,
  isOutputRepetitionGuardEnabled,
  buildOutputRepetitionEvent,
  decideOutputRepetition,
} from '../../src/native/output-repetition.js'

// Helpers to build inputs.
const repeat = (line: string, n: number): string =>
  Array.from({ length: n }, () => line).join('\n')
const cycle = (lines: string[], n: number): string =>
  Array.from({ length: n }, () => lines.join('\n')).join('\n')

describe('detectOutputRepetition — degenerate output must be flagged', () => {
  it('flags a substantive line spammed 6+ times (exact_line)', () => {
    const v = detectOutputRepetition(repeat('处理失败，请稍后重试该请求。', 8))
    expect(v).not.toBeNull()
    expect(v!.kind).toBe('exact_line')
    expect(v!.count).toBeGreaterThanOrEqual(6)
  })

  it('flags the dogfood report cycle (bullet + divider + section repeated)', () => {
    const text = cycle([
      '• 06-08：只有 enter_chat事件，无新消息',
      '────────────────────────────────────────',
      '建议立即执行：重启网关清理卡住会话',
    ], 12)
    expect(detectOutputRepetition(text)).not.toBeNull()
  })

  it('flags a low-diversity block: 5 distinct lines cycled 5x (each <6 so not exact)', () => {
    const v = detectOutputRepetition(cycle([
      '第一阶段需要梳理生产环境补丁',
      '第二阶段需要梳理测试环境状态',
      '第三阶段需要对比两边差异点',
      '第四阶段需要制定同步部署计划',
      '第五阶段需要执行并验证结果',
    ], 5))
    expect(v).not.toBeNull()
    expect(v!.kind).toBe('low_diversity')
  })

  it('returns a human-facing reason mentioning repetition', () => {
    const v = detectOutputRepetition(repeat('同一句车轱辘话反复输出占位。', 7))
    expect(v!.reason.toLowerCase()).toMatch(/repeat|repetition|loop/)
  })
})

describe('detectOutputRepetition — legitimate output must NOT be flagged (no false positives)', () => {
  it('passes normal multi-paragraph prose', () => {
    const text = [
      '我先梳理了生产环境的当前状态，确认网关容器已运行四天。',
      '',
      '随后检查了审计日志，发现汤建荣的几条请求都排队在卡死会话后面。',
      '',
      '结论是中间件正常，问题在 AI 网关侧，建议重启并归档膨胀会话。',
    ].join('\n')
    expect(detectOutputRepetition(text)).toBeNull()
  })

  it('passes a markdown table with distinct rows', () => {
    const text = [
      '| 层级 | 问题 | 证据 |',
      '|------|------|------|',
      '| 模型服务 | 频繁 unavailable | FailoverError |',
      '| 上下文 | 错误累积 | Context overflow |',
      '| 会话阻塞 | 新请求排队 | age=2399s |',
    ].join('\n')
    expect(detectOutputRepetition(text)).toBeNull()
  })

  it('passes a checklist with eight distinct items', () => {
    const text = [
      '- 同步 session-health-report.js',
      '- 同步 session-lifecycle-guard.js',
      '- 同步 zhoumi-weekly-plan.js',
      '- 同步 verify-cron-exec-health.js',
      '- 同步 verify-prod-hardening.js',
      '- 同步 wecom-query-audit.js',
      '- 同步 daily-personnel-report.js',
      '- 同步 daily-shhw-report.js',
    ].join('\n')
    expect(detectOutputRepetition(text)).toBeNull()
  })

  it('passes a fenced code block with many repeated trivial lines (}, blanks)', () => {
    const text = [
      '这是部署脚本：',
      '```bash',
      'for f in "${FILES[@]}"; do',
      '  scp "$f" "$TEST:$TMP/"',
      '}',
      '}',
      '}',
      '}',
      '}',
      '}',
      '}',
      '}',
      '```',
      '执行后验证文件大小。',
    ].join('\n')
    expect(detectOutputRepetition(text)).toBeNull()
  })

  it('passes a sectioned document with several --- dividers between distinct content', () => {
    const text = [
      '排查结论：网关侧问题',
      '---',
      '根因链：模型不稳定 + 上下文膨胀 + 会话阻塞',
      '---',
      '时间线：06-06 连发三条均无回复',
      '---',
      '建议：重启网关并归档膨胀会话',
      '---',
      '加剧因素：SKILL.md grounding 失效',
    ].join('\n')
    expect(detectOutputRepetition(text)).toBeNull()
  })

  it('passes a short reply', () => {
    expect(detectOutputRepetition('好的，我这就去重启网关并验证。')).toBeNull()
  })

  it('does not flag repeated blank/trivial lines alone', () => {
    expect(detectOutputRepetition(repeat('', 12))).toBeNull()
    expect(detectOutputRepetition(repeat('}', 12))).toBeNull()
    expect(detectOutputRepetition(repeat('---', 8))).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(detectOutputRepetition('')).toBeNull()
    expect(detectOutputRepetition('   \n  \n')).toBeNull()
  })
})

describe('output-repetition gating (default OFF — zero behavior change)', () => {
  it('shadow flag defaults off, true only for truthy env', () => {
    expect(isOutputRepetitionShadowEnabled({})).toBe(false)
    expect(isOutputRepetitionShadowEnabled({ OWLCODA_OUTPUT_REPETITION_SHADOW: '1' })).toBe(true)
    expect(isOutputRepetitionShadowEnabled({ OWLCODA_OUTPUT_REPETITION_SHADOW: 'on' })).toBe(true)
    expect(isOutputRepetitionShadowEnabled({ OWLCODA_OUTPUT_REPETITION_SHADOW: 'off' })).toBe(false)
  })

  it('guard flag defaults off, true only for truthy env', () => {
    expect(isOutputRepetitionGuardEnabled({})).toBe(false)
    expect(isOutputRepetitionGuardEnabled({ OWLCODA_OUTPUT_REPETITION_GUARD: 'true' })).toBe(true)
    expect(isOutputRepetitionGuardEnabled({ OWLCODA_OUTPUT_REPETITION_GUARD: '0' })).toBe(false)
  })
})

describe('decideOutputRepetition — pure wiring decision', () => {
  const DEGENERATE = repeat('同一句车轱辘话被反复输出占位。', 8)
  const HEALTHY = '好的，我这就重启网关并归档膨胀会话，然后验证。'

  it('no flags → action none even for degenerate text (zero behavior change)', () => {
    expect(decideOutputRepetition(DEGENERATE, {}).action).toBe('none')
  })

  it('shadow flag + degenerate → action shadow with verdict', () => {
    const d = decideOutputRepetition(DEGENERATE, { OWLCODA_OUTPUT_REPETITION_SHADOW: '1' })
    expect(d.action).toBe('shadow')
    if (d.action === 'shadow') expect(d.verdict.kind).toBe('exact_line')
  })

  it('shadow flag + healthy text → action none', () => {
    expect(decideOutputRepetition(HEALTHY, { OWLCODA_OUTPUT_REPETITION_SHADOW: '1' }).action).toBe('none')
  })

  it('guard flag + degenerate → action guard with a retry/model reason', () => {
    const d = decideOutputRepetition(DEGENERATE, { OWLCODA_OUTPUT_REPETITION_GUARD: '1' })
    expect(d.action).toBe('guard')
    if (d.action === 'guard') expect(d.reason).toMatch(/retry|model/i)
  })

  it('guard takes precedence when both flags set', () => {
    expect(decideOutputRepetition(DEGENERATE, {
      OWLCODA_OUTPUT_REPETITION_SHADOW: '1',
      OWLCODA_OUTPUT_REPETITION_GUARD: '1',
    }).action).toBe('guard')
  })
})

describe('buildOutputRepetitionEvent — telemetry envelope', () => {
  it('carries the verdict kind + count under the output_repetition event type', () => {
    const v = detectOutputRepetition(repeat('车轱辘话反复输出占位句子。', 7))!
    const env = buildOutputRepetitionEvent(v)
    expect(env.eventType).toBe('output_repetition')
    expect(env.surface).toBe('telemetry')
    expect(env.decision).toBe('observe')
    expect(env.attributes?.kind).toBe('exact_line')
    expect(env.attributes?.count).toBeGreaterThanOrEqual(6)
  })
})
