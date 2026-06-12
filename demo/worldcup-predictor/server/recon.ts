// T4: optional web reconnaissance stage. Runs owlcoda HEADLESS (the agent,
// not just the proxy) so it can use owlcoda's own WebSearch/WebFetch tools.
// This is the demo's showcase of owlcoda-as-an-agent: the same binary that
// routes models can also go gather sourced intelligence.
import { execFile } from 'node:child_process'

export interface ReconResult {
  text: string
  sources: Array<{ title: string; url: string }>
  model: string
  durationMs: number
}

export function parseReconOutput(stdout: string): { text: string; sources: Array<{ title: string; url: string }> } {
  // owlcoda run --json prints one JSON object: { text, tool_calls: [...] }
  const start = stdout.indexOf('{')
  const payload = JSON.parse(stdout.slice(start)) as {
    text?: string
    tool_calls?: Array<{ tool: string; output?: string }>
  }
  const text = payload.text ?? ''
  const sources: Array<{ title: string; url: string }> = []
  const seen = new Set<string>()
  const collect = (blob: string) => {
    // WebSearch output format: "N. <title>\n   <url>"
    const re = /^\s*\d+\.\s+(.+)\n\s+(https?:\/\/\S+)/gm
    for (const m of blob.matchAll(re)) {
      if (!seen.has(m[2])) {
        seen.add(m[2])
        sources.push({ title: m[1].trim(), url: m[2] })
      }
    }
    // fallback: bare URLs
    for (const m of blob.matchAll(/https?:\/\/[^\s)"\]]+/g)) {
      if (!seen.has(m[0])) {
        seen.add(m[0])
        sources.push({ title: m[0], url: m[0] })
      }
    }
  }
  for (const call of payload.tool_calls ?? []) {
    if (/web/i.test(call.tool) && call.output) collect(call.output)
  }
  collect(text)
  return { text, sources }
}

export function runWebRecon(opts: {
  model: string
  homeTeam: string
  awayTeam: string
  kickoff: string
  onDelta?: (text: string) => void
  timeoutMs?: number
}): Promise<ReconResult> {
  const started = Date.now()
  const prompt = `联网搜索 2026 世界杯 ${opts.homeTeam} vs ${opts.awayTeam}(开球 ${opts.kickoff})的赛前情报:近期状态、伤停、首发消息、盘口动向。
要求:1) 只陈述来源中真实出现的内容,每条要点标注来源;2) 区分事实与媒体观点;3) 控制在10条要点以内;4) 最后列出全部来源URL。`
  return new Promise((resolve, reject) => {
    const child = execFile(
      'owlcoda',
      ['run', '--model', opts.model, '-p', prompt, '--json', '--auto-approve'],
      { timeout: opts.timeoutMs ?? 240_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return reject(new Error(`owlcoda headless failed: ${err.message}`))
        try {
          const { text, sources } = parseReconOutput(stdout)
          resolve({ text, sources, model: opts.model, durationMs: Date.now() - started })
        } catch (parseErr) {
          reject(new Error(`recon output unparseable: ${String(parseErr)}`))
        }
      },
    )
    child.stdout?.on('data', (chunk: Buffer | string) => opts.onDelta?.(String(chunk)))
  })
}
