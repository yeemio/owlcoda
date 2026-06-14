// 赛果摄入:owlcoda HEADLESS 抓最终比分。镜像 recon.ts。owlcoda 是来路,
// 人是闸门——这里只产 pending 提案,确认由 store/endpoint 负责。绝不编造比分。
import { execFile } from 'node:child_process'
import type { Outcome, ResultStatus, SourceStatus } from '../framework/types.js'

export interface ResultProposal {
  home_goals: number | null
  away_goals: number | null
  outcome: Outcome | null
  status: ResultStatus
  scorers?: Array<{ team: 'home' | 'away'; player: string; minute?: number }>
  source_urls: string[]
  confidence: SourceStatus
}

function outcomeOf(h: number, a: number): Outcome {
  return h > a ? 'home' : h < a ? 'away' : 'draw'
}

function collectUrls(payload: { text?: string; tool_calls?: Array<{ tool: string; output?: string }> }): string[] {
  const urls = new Set<string>()
  const scan = (s?: string) => {
    for (const m of (s ?? '').matchAll(/https?:\/\/[^\s)"\]]+/g)) urls.add(m[0])
  }
  for (const c of payload.tool_calls ?? []) if (/web/i.test(c.tool)) scan(c.output)
  scan(payload.text)
  return [...urls]
}

const unsupported = (urls: string[] = []): ResultProposal => ({
  home_goals: null, away_goals: null, outcome: null, status: 'unsupported', source_urls: urls, confidence: 'unsupported',
})

// Find a flat JSON object carrying numeric home_goals/away_goals. Tries the
// whole candidate first, then scans each brace-delimited fragment.
function extractScore(candidate: string): { home_goals: number; away_goals: number } | null {
  const tryParse = (s: string) => {
    try {
      const o = JSON.parse(s) as { home_goals?: unknown; away_goals?: unknown }
      if (typeof o.home_goals === 'number' && typeof o.away_goals === 'number') {
        return { home_goals: o.home_goals, away_goals: o.away_goals }
      }
    } catch { /* not JSON */ }
    return null
  }
  const whole = tryParse(candidate.trim())
  if (whole) return whole
  for (const m of candidate.matchAll(/\{[\s\S]*?\}/g)) {
    const got = tryParse(m[0])
    if (got) return got
  }
  return null
}

export function parseResultOutput(stdout: string, _home: string, _away: string): ResultProposal {
  const start = stdout.indexOf('{')
  if (start === -1) return unsupported()
  let payload: { text?: string; tool_calls?: Array<{ tool: string; output?: string }> }
  try {
    payload = JSON.parse(stdout.slice(start))
  } catch {
    return unsupported()
  }
  const source_urls = collectUrls(payload)
  const text = payload.text ?? ''
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fence ? fence[1] : text
  const scored = extractScore(candidate)
  if (scored) {
    const h = scored.home_goals
    const a = scored.away_goals
    return {
      home_goals: h, away_goals: a, outcome: outcomeOf(h, a),
      status: 'final', source_urls, confidence: source_urls.length ? 'supported' : 'partial',
    }
  }
  return unsupported(source_urls)
}

export function runResultFetch(opts: {
  model: string
  homeTeam: string
  awayTeam: string
  kickoff: string
  timeoutMs?: number
}): Promise<ResultProposal> {
  const prompt = `联网核实 2026 世界杯 ${opts.homeTeam}(主) vs ${opts.awayTeam}(客)(开球 ${opts.kickoff})的最终比分。
要求:1) 只采纳来源中真实出现的终场比分,至少两处一致;2) 找不到可靠终场比分就直说未找到,不要猜;
3) 最后用代码块输出 \`\`\`json {"home_goals":<主队进球>,"away_goals":<客队进球>,"status":"final"} \`\`\`;
4) 列出全部来源 URL。`
  return new Promise((resolve, reject) => {
    execFile(
      'owlcoda',
      ['run', '--model', opts.model, '-p', prompt, '--json', '--auto-approve'],
      { timeout: opts.timeoutMs ?? 240_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return reject(new Error(`owlcoda headless failed: ${err.message}`))
        try {
          resolve(parseResultOutput(stdout, opts.homeTeam, opts.awayTeam))
        } catch (parseErr) {
          reject(new Error(`result output unparseable: ${String(parseErr)}`))
        }
      },
    )
  })
}
