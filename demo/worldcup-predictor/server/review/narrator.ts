import { streamMessage } from '../owlcoda.js'
import type { ReviewScorecard } from '../framework/types.js'

export function buildNarratorPrompt(sc: ReviewScorecard, homeTeam: string, awayTeam: string): { system: string; user: string } {
  const system = `你是足球分析复盘员。你只能依据下面记分卡里的数字来叙述,不得编造任何记分卡之外的事实、比分、伤停或赔率。
输出 3-5 句中文复盘:1) 真实结果;2) 数学基线 vs 三角辩论终判谁更准(用 p_actual / Brier);3) 辩论相对基线的增量(debate_vs_baseline);4) 让球 lean 的兑现(verdict);5) 一句客观结论。诚实标注 CLV 为 n/a 的局限。`
  const user = `比赛:${homeTeam}(主) vs ${awayTeam}(客)
记分卡 JSON:
${JSON.stringify(sc, null, 2)}`
  return { system, user }
}

export async function narrateScorecard(opts: {
  baseUrl: string
  model: string
  scorecard: ReviewScorecard
  homeTeam: string
  awayTeam: string
}): Promise<string> {
  const { system, user } = buildNarratorPrompt(opts.scorecard, opts.homeTeam, opts.awayTeam)
  const r = await streamMessage({ baseUrl: opts.baseUrl, model: opts.model, system, user, maxTokens: 4096 })
  return r.text.trim()
}
