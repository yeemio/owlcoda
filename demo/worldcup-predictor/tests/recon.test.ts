import { describe, expect, it } from 'vitest'
import { parseReconOutput } from '../server/recon.js'

const SAMPLE = JSON.stringify({
  text: '要点1:东道主首秀。来源:https://example.com/a\n\n来源清单见上。',
  tool_calls: [
    {
      tool: 'WebSearch',
      input: { query: 'x' },
      output:
        'Search: "x"\nResults: 2\n\n1. 加拿大VS波黑前瞻:主场仅输1场\n   https://news.qq.com/rain/a/123\n   摘要…\n\n2. B组首轮分析\n   https://www.sohu.com/a/456\n   摘要…\n',
    },
  ],
})

describe('parseReconOutput', () => {
  it('extracts titled sources from WebSearch output and dedupes URLs', () => {
    const { text, sources } = parseReconOutput(`some log noise\n${SAMPLE}`)
    expect(text).toContain('东道主首秀')
    const urls = sources.map((s) => s.url)
    expect(urls).toContain('https://news.qq.com/rain/a/123')
    expect(urls).toContain('https://www.sohu.com/a/456')
    expect(sources.find((s) => s.url.includes('qq.com'))?.title).toContain('前瞻')
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('throws on unparseable output', () => {
    expect(() => parseReconOutput('no json at all')).toThrow()
  })
})
