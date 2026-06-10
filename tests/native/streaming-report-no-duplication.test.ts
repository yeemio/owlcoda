import { describe, it, expect } from 'vitest'
import { renderMarkdown, StreamingMarkdownRenderer } from '../../src/native/markdown.js'
import { composeAssistantChunk, drainAssistantStreamBoundary, type ComposeState } from '../../src/native/repl-shared.js'
import { stripAnsi } from '../../src/native/tui/colors.js'

// ── Verification: does owlcoda's streaming render pipeline DUPLICATE content? ──
//
// A dogfood session (kimi-code, 0.14.59) committed a root-cause report whose
// transcript showed the same lines ("• 06-08：只有 enter_chat事件，无新消息",
// "────") spammed dozens of times, with sections jumbled. Question: was that
// the MODEL repeating tokens, or did owlcoda's streaming markdown renderer
// amplify a single occurrence across chunk boundaries?
//
// This replays a report whose SOURCE has every line exactly once, through the
// REAL live-REPL streaming path (composeAssistantChunk → StreamingMarkdownRenderer
// .push, accumulated as appendTranscript does) at many chunk granularities.
// If the renderer were the culprit, a unique source line would appear MORE than
// once in the accumulated transcript at some chunk size.

const freshState = (): ComposeState => ({ seenAnchors: new Set(), leftover: '' })

// Screenshot-shaped: sections, `---` hrules (render to ────), a GFM table,
// bullets, ordered list. Every line is UNIQUE in the source.
const REPORT = [
  '排查结论：汤建荣请求经常无法响应',
  '',
  'MES中间件本身正常，问题完全在 OpenClaw AI 网关侧。',
  '',
  '---',
  '',
  '根因链（三层叠加）',
  '',
  '| 层级 | 问题 | 证据 |',
  '|------|------|------|',
  '| 模型服务不稳定 | 主模型频繁 unavailable | FailoverError 多次 |',
  '| 上下文膨胀 | 错误消息累积到会话里 | Context overflow 三次 |',
  '| Stuck Session 阻塞 | 会话卡住后新请求全部排队 | age=2399s |',
  '',
  '---',
  '',
  '具体时间线',
  '',
  '- 06-06 连发三条派工查询，均无回复',
  '- 06-06 16:29 起 agent:main:main 卡住，最长四十分钟',
  '- 06-07 17:03 悠哈查询路由到已卡死会话，排队后被强制 abort',
  '- 06-08：只有 enter_chat事件，无新消息',
  '',
  '---',
  '',
  '加剧因素：SKILL.md Grounding 失效',
  '',
  '- web_fetch 不支持 file:// 协议',
  '- pdf 工具全部图像模型失败',
  '- nodes 工具缺少 node 运行时',
  '',
  '---',
  '',
  '建议立即执行',
  '',
  '1. 重启网关清理卡住会话',
  '2. 归档汤建荣的膨胀会话文件',
  '3. 修复 grounding 文件读取链路',
  '4. 缩短 stuck session 检测窗口到分钟级',
  '',
].join('\n')

/** Replay through the REAL streaming path, accumulating every push() output
 *  the way onText → appendTranscript does, then the turn-end boundary flush. */
function streamAccumulate(md: string, chunkSize: number): string {
  const state = freshState()
  const renderer = new StreamingMarkdownRenderer()
  let out = ''
  for (let i = 0; i < md.length; i += chunkSize) {
    const chunk = md.slice(i, i + chunkSize)
    const composed = composeAssistantChunk(chunk, state)
    out += renderer.push(composed)
  }
  // Turn/tool boundary drain (drainAssistantStreamBoundary): flush composer
  // leftover through, then flush the renderer.
  if (state.leftover.length > 0) {
    out += renderer.push(composeAssistantChunk('\n', state))
  }
  out += renderer.flush()
  return out
}

/** Count occurrences of a substring (plain-text, ANSI-stripped). */
function count(haystack: string, needle: string): number {
  const plain = stripAnsi(haystack)
  let n = 0
  let idx = plain.indexOf(needle)
  while (idx !== -1) { n++; idx = plain.indexOf(needle, idx + needle.length) }
  return n
}

/** Whitespace-insensitive count: tolerant of benign line-splitting (a tool
 *  boundary can split a narration line in two), but still catches duplication
 *  (→ 2) and content loss (→ 0). */
function countDeWs(haystack: string, needle: string): number {
  return count(stripAnsi(haystack).replace(/\s+/g, ''), needle.replace(/\s+/g, ''))
}

// Distinctive source fragments — each appears EXACTLY ONCE in REPORT.
const PROBES = [
  '只有 enter_chat事件，无新消息',
  '排查结论：汤建荣请求经常无法响应',
  '加剧因素',
  '缩短 stuck session 检测窗口到分钟级',
  '主模型频繁 unavailable',
  '悠哈查询路由到已卡死会话',
]

const CHUNK_SIZES = [1, 2, 3, 5, 7, 11, 13, 17, 29, 50, 137, 100000]

describe('streaming render does NOT amplify report content (dogfood garble check)', () => {
  it('sanity: each probe occurs exactly once in the source', () => {
    for (const p of PROBES) expect(count(REPORT, p), p).toBe(1)
  })

  it('full-pass renderMarkdown emits each probe exactly once', () => {
    const full = renderMarkdown(REPORT)
    for (const p of PROBES) expect(count(full, p), p).toBe(1)
  })

  for (const size of CHUNK_SIZES) {
    it(`streaming@chunk=${size}: every probe appears exactly once (no amplification)`, () => {
      const streamed = streamAccumulate(REPORT, size)
      for (const p of PROBES) {
        expect(count(streamed, p), `"${p}" amplified at chunk=${size}`).toBe(1)
      }
    })
  }

  it('total committed line count is stable across chunk sizes (no jumble/re-emit)', () => {
    const baseline = stripAnsi(streamAccumulate(REPORT, 100000))
      .split('\n').filter(l => l.trim()).length
    for (const size of CHUNK_SIZES) {
      const lines = stripAnsi(streamAccumulate(REPORT, size))
        .split('\n').filter(l => l.trim()).length
      // Allow ±2 for benign boundary blank-line differences; a re-emit bug
      // would balloon this far beyond the baseline.
      expect(Math.abs(lines - baseline), `line count drift at chunk=${size}: ${lines} vs ${baseline}`)
        .toBeLessThanOrEqual(2)
    }
  })
})

// The report streamed AFTER many bash tool calls. A tool start fires
// flushBufferedAssistantResponse (→ drainAssistantStreamBoundary) mid-stream.
// If that boundary drain re-emitted buffered content, the report would
// duplicate. Replay with boundary drains injected between chunks.
describe('tool-boundary drains mid-report do not re-emit content', () => {
  function streamWithBoundaries(md: string, chunkSize: number, drainEvery: number): string {
    const state = freshState()
    const renderer = new StreamingMarkdownRenderer()
    let out = ''
    const append = (rendered: string): void => { out += rendered }
    let sinceDrain = 0
    for (let i = 0; i < md.length; i += chunkSize) {
      const composed = composeAssistantChunk(md.slice(i, i + chunkSize), state)
      out += renderer.push(composed)
      if (++sinceDrain >= drainEvery) {
        sinceDrain = 0
        // Mirrors a tool start: drain the no-newline tail through the renderer.
        drainAssistantStreamBoundary({ composeState: state, renderer, appendRendered: append })
      }
    }
    drainAssistantStreamBoundary({ composeState: state, renderer, appendRendered: append })
    out += renderer.flush()
    return out
  }

  for (const drainEvery of [1, 2, 4, 8]) {
    it(`drainEvery=${drainEvery}: each probe preserved exactly once (no dup, no loss)`, () => {
      const streamed = streamWithBoundaries(REPORT, 7, drainEvery)
      // De-whitespace: a mid-line tool boundary may split a narration line in
      // two (benign). Duplication would yield 2; content loss would yield 0.
      for (const p of PROBES) {
        expect(countDeWs(streamed, p), `"${p}" not preserved-once with drains every ${drainEvery}`).toBe(1)
      }
    })
  }
})

// Transparency: if the MODEL itself degenerates and emits the same line N
// times (what kimi-code did), the renderer must pass exactly N through —
// not collapse to 1, not amplify. This confirms the screenshot's dozens of
// repeats were the model's tokens, faithfully shown, not a renderer artifact.
describe('renderer is transparent to model-side repetition', () => {
  for (const n of [3, 8, 25]) {
    it(`model emits a line ${n}× → committed output has exactly ${n}`, () => {
      const SPAM = '• 06-08：只有 enter_chat事件，无新消息'
      const md = Array.from({ length: n }, () => SPAM).join('\n') + '\n'
      const streamed = streamAccumulate(md, 5)
      expect(count(streamed, '只有 enter_chat事件，无新消息')).toBe(n)
    })
  }
})
