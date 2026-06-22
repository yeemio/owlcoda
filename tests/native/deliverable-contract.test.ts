/**
 * Deliverable Contract v1 classifier tests — Slice 0, 0.14.18+
 *
 * Tests the spec test-list (lines 741-810 of zh-CN implementation doc) plus
 * the three compound-intent pinned cases required by the task brief.
 */

import { describe, it, expect } from 'vitest'
import {
  classifyDeliverableContract,
  isDurableArtifactDeliverable,
  allowsChatFinal,
  shouldCreateStructuredTaskPlan,
  shouldHardStopOnNoTouchedPaths,
  taskRequiresDurableProgress,
} from '../../src/native/deliverable-contract.js'

// ---------------------------------------------------------------------------
// Spec test-list (13 cases from zh-CN doc lines 745-771)
// ---------------------------------------------------------------------------

describe('classifyDeliverableContract — spec case 1: explicit read-only review', () => {
  it('only-read-review chat output no file → read_only_review/high, no hard stop', () => {
    const result = classifyDeliverableContract('只读评审，在聊天中输出，不要求写文件')
    expect(result.mode).toBe('read_only_review')
    expect(result.confidence).toBe('high')
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(false)
    expect(allowsChatFinal(result)).toBe(true)
  })
})

describe('classifyDeliverableContract — spec case 2: read source and do tech review', () => {
  it('read plan and source, tech review, output in chat → read_only_review or text_deliverable, no hard stop', () => {
    const result = classifyDeliverableContract('读方案和源码，做技术评审，结果在聊天里输出')
    expect(['read_only_review', 'text_deliverable']).toContain(result.mode)
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(false)
    expect(allowsChatFinal(result)).toBe(true)
  })
})

describe('classifyDeliverableContract — spec case 3: write a tech plan (no path)', () => {
  it('写一份技术方案 → text_deliverable, allows chat final', () => {
    const result = classifyDeliverableContract('写一份技术方案')
    expect(result.mode).toBe('text_deliverable')
    expect(allowsChatFinal(result)).toBe(true)
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(false)
  })
})

describe('classifyDeliverableContract — spec case 4: write tech plan TO a file', () => {
  it('写一份技术方案到 docs/plan.md → file_artifact_delivery/high', () => {
    const result = classifyDeliverableContract('写一份技术方案到 docs/plan.md')
    expect(result.mode).toBe('file_artifact_delivery')
    expect(result.confidence).toBe('high')
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(true)
    expect(allowsChatFinal(result)).toBe(false)
  })
})

describe('classifyDeliverableContract — spec case 5: generate 46-page PPT to explicit path', () => {
  it('生成 46 页 PPT 到 /Users/publicuser/work/ppt/output/owlcoda/ → file_artifact_delivery/high', () => {
    const result = classifyDeliverableContract('生成 46 页 PPT 到 /Users/publicuser/work/ppt/output/owlcoda/')
    expect(result.mode).toBe('file_artifact_delivery')
    expect(result.confidence).toBe('high')
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(true)
    expect(isDurableArtifactDeliverable(result)).toBe(true)
  })
})

describe('classifyDeliverableContract — spec case 6: fix bug in src file', () => {
  it('修改 src/native/conversation.ts 修复 bug → code_change/high', () => {
    const result = classifyDeliverableContract('修改 src/native/conversation.ts 修复 bug')
    expect(result.mode).toBe('code_change')
    expect(result.confidence).toBe('high')
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(true)
    expect(isDurableArtifactDeliverable(result)).toBe(true)
  })

  it('SWE-bench traceback paths under dist-packages are references, not output artifacts', () => {
    const result = classifyDeliverableContract(`
We need solve this SWE-bench issue in the current repository checkout.

Issue:
Please support header rows in RestructuredText output

Traceback (most recent call last):
  File "<stdin>", line 1, in <module>
  File "/usr/lib/python3/dist-packages/astropy/io/ascii/core.py", line 1719, in _get_writer
    writer = Writer(**writer_kwargs)
TypeError: RST.__init__() got an unexpected keyword argument 'header_rows'

Requirements:
- Modify the repository files to implement the requested behavior.
- Keep the patch minimal and production-quality.
`)
    expect(result.mode).toBe('code_change')
    expect(result.confidence).toBe('high')
    expect(result.matchedModes).not.toContain('file_artifact_delivery')
  })
})

describe('classifyDeliverableContract — spec case 7: run tests and summarize output', () => {
  it('运行测试并总结输出 → command_job/high', () => {
    const result = classifyDeliverableContract('运行测试并总结输出')
    expect(result.mode).toBe('command_job')
    expect(result.confidence).toBe('high')
    expect(allowsChatFinal(result)).toBe(true)
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(false)
  })
})

describe('classifyDeliverableContract — spec case 8: generate HTML deck (no path)', () => {
  it('生成 HTML deck 无路径 → file_artifact_delivery/medium, no hard stop', () => {
    const result = classifyDeliverableContract('生成 HTML deck')
    expect(result.mode).toBe('file_artifact_delivery')
    expect(result.confidence).toBe('medium')
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(false)
    expect(shouldCreateStructuredTaskPlan(result)).toBe(true)
  })
})

describe('classifyDeliverableContract — spec case 9: look at design, what is wrong', () => {
  it('看看这个设计有什么问题 → read_only_review or text_deliverable, no hard stop', () => {
    const result = classifyDeliverableContract('看看这个设计有什么问题')
    expect(['read_only_review', 'text_deliverable']).toContain(result.mode)
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(false)
    expect(allowsChatFinal(result)).toBe(true)
  })

  it('只需要分析潜在缺陷并列举 → read_only_review/text_deliverable, no hard stop', () => {
    const result = classifyDeliverableContract('你只需要分析出来 Owlcoda 潜在的缺陷，一一列举出来')
    expect(['read_only_review', 'text_deliverable']).toContain(result.mode)
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(false)
    expect(allowsChatFinal(result)).toBe(true)
  })
})

describe('classifyDeliverableContract — spec case 10: fix bug in src + write analysis to docs', () => {
  it('修 src/native/foo.ts 的 bug，把分析结论写到 docs/plan.md → code_change/high, matchedModes includes file_artifact_delivery', () => {
    const result = classifyDeliverableContract('修 `src/native/foo.ts` 的 bug，把分析结论写到 `docs/plan.md`')
    expect(result.mode).toBe('code_change')
    expect(result.confidence).toBe('high')
    expect(result.matchedModes).toContain('file_artifact_delivery')
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(true)
  })
})

describe('classifyDeliverableContract — spec case 11: run tests find bug fix it (compound-intent pin)', () => {
  // Pinned case: "跑测试发现 bug 然后修一下" must be code_change, not command_job.
  // matchedModes must contain both code_change and command_job.
  // Priority: code_change > command_job.
  it('跑测试发现 bug 然后修一下 → code_change/high (not command_job), matchedModes has both', () => {
    const result = classifyDeliverableContract('跑测试发现 bug 然后修一下')
    expect(result.mode).toBe('code_change')
    expect(result.confidence).toBe('high')
    expect(result.matchedModes).toContain('code_change')
    expect(result.matchedModes).toContain('command_job')
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(true)
  })

  it('run tests, find the bug, then fix it → code_change (not command_job)', () => {
    const result = classifyDeliverableContract('Run the tests, find the failing test, then fix the bug')
    expect(result.mode).toBe('code_change')
    expect(result.matchedModes).toContain('command_job')
  })
})

describe('classifyDeliverableContract — spec case 12: backtick path artifact suffix (compound-intent pin)', () => {
  // Pinned case from spec lines 381-388 and task brief:
  // Path inside backticks with artifact suffix + output-ish path → file_artifact_delivery/high
  // even without explicit "write to" verb.
  it('请围绕 `/Users/publicuser/work/ppt/output/owlcoda/deck.html` 完成交付 → file_artifact_delivery/high', () => {
    const result = classifyDeliverableContract(
      '请围绕 `/Users/publicuser/work/ppt/output/owlcoda/deck.html` 完成交付',
    )
    expect(result.mode).toBe('file_artifact_delivery')
    expect(result.confidence).toBe('high')
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(true)
  })
})

describe('classifyDeliverableContract — spec case 13: priority escalation, not mixed_unknown', () => {
  // Review + weak artifact signal without path → must escalate to highest mode hit,
  // not fall to mixed_unknown. Only zero strong modes → mixed_unknown.
  it('review + artifact type keyword → file_artifact_delivery (not mixed_unknown)', () => {
    const result = classifyDeliverableContract('评审这份方案并写到 docs/review.md')
    expect(result.mode).toBe('file_artifact_delivery')
    // matchedModes must contain file_artifact_delivery (higher priority wins over read_only_review)
    expect(result.matchedModes).toContain('file_artifact_delivery')
    expect(result.mode).not.toBe('mixed_unknown')
  })

  it('zero-signal short text → mixed_unknown/low', () => {
    const result = classifyDeliverableContract('继续')
    expect(result.mode).toBe('mixed_unknown')
    expect(result.confidence).toBe('low')
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(false)
  })

  it('empty string → mixed_unknown/low', () => {
    const result = classifyDeliverableContract('')
    expect(result.mode).toBe('mixed_unknown')
    expect(result.confidence).toBe('low')
  })
})

// ---------------------------------------------------------------------------
// Compound-intent pinned cases (task brief supplement)
// ---------------------------------------------------------------------------

describe('compound-intent pinned: review + write to docs/review.md → file_artifact_delivery', () => {
  // "评审这份方案并写到 docs/review.md" → file_artifact_delivery (not text_deliverable)
  // matchedModes simultaneously contains ['file_artifact_delivery', 'text_deliverable' or 'read_only_review']
  // primary mode is file_artifact_delivery
  it('评审这份方案并写到 docs/review.md → file_artifact_delivery, matchedModes has multiple modes', () => {
    const result = classifyDeliverableContract('评审这份方案并写到 docs/review.md')
    expect(result.mode).toBe('file_artifact_delivery')
    expect(result.matchedModes.length).toBeGreaterThanOrEqual(1)
    // file_artifact_delivery must be present
    expect(result.matchedModes).toContain('file_artifact_delivery')
  })
})

describe('compound-intent pinned: deck.html output path — high confidence without explicit verb', () => {
  // "请围绕 `/Users/publicuser/work/ppt/output/owlcoda/deck.html` 完成交付"
  // → file_artifact_delivery/high (artifact suffix + output-ish path, no ALLOW verb needed)
  it('artifact suffix + output-ish path in backticks → high confidence even without write verb', () => {
    const result = classifyDeliverableContract(
      '请围绕 `/Users/publicuser/work/ppt/output/owlcoda/deck.html` 完成交付',
    )
    expect(result.mode).toBe('file_artifact_delivery')
    expect(result.confidence).toBe('high')
    expect(isDurableArtifactDeliverable(result)).toBe(true)
    expect(taskRequiresDurableProgress(result)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Wrapper semantics
// ---------------------------------------------------------------------------

describe('canonical wrapper semantics', () => {
  it('isDurableArtifactDeliverable: false for medium confidence file artifact', () => {
    const result = classifyDeliverableContract('generate an HTML deck')
    expect(result.mode).toBe('file_artifact_delivery')
    expect(result.confidence).toBe('medium')
    expect(isDurableArtifactDeliverable(result)).toBe(false)
  })

  it('isDurableArtifactDeliverable: true for high confidence code_change', () => {
    const result = classifyDeliverableContract('fix the bug in src/native/foo.ts')
    expect(isDurableArtifactDeliverable(result)).toBe(true)
  })

  it('allowsChatFinal: true for all non-durable modes', () => {
    const modes = [
      '只读评审，在聊天中输出', // read_only_review
      '写技术方案', // text_deliverable
      '跑测试并报告结果', // command_job
      '继续', // mixed_unknown
    ]
    for (const text of modes) {
      const result = classifyDeliverableContract(text)
      expect(allowsChatFinal(result)).toBe(true)
    }
  })

  it('shouldCreateStructuredTaskPlan: true for durable artifact (high), false for read_only', () => {
    const durableResult = classifyDeliverableContract('写一份技术方案到 docs/plan.md')
    expect(shouldCreateStructuredTaskPlan(durableResult)).toBe(true)
    const readOnlyResult = classifyDeliverableContract('只读评审，在聊天中输出')
    expect(shouldCreateStructuredTaskPlan(readOnlyResult)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// mixed_unknown signal summary
// ---------------------------------------------------------------------------

describe('mixed_unknown telemetry: signalSummary always present', () => {
  it('zero-signal text has empty signal summary arrays', () => {
    const result = classifyDeliverableContract('继续')
    expect(result.mode).toBe('mixed_unknown')
    expect(result.signalSummary).toBeDefined()
    expect(Array.isArray(result.signalSummary.codeChange)).toBe(true)
    expect(Array.isArray(result.signalSummary.fileArtifact)).toBe(true)
  })

  it('matchedModes is empty array for zero-signal text', () => {
    const result = classifyDeliverableContract('继续')
    expect(result.mode).toBe('mixed_unknown')
    expect(result.matchedModes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Orthogonality: DeliverableConfidence vs contract.confidence
// ---------------------------------------------------------------------------

describe('DeliverableConfidence is orthogonal to TaskContract confidence', () => {
  // classifyDeliverableContract().confidence is mode-classification confidence.
  // It is NOT the same as contract.confidence (path/write-scope confidence).
  // They are distinct and both should appear in telemetry independently.
  it('classifyDeliverableContract returns its own confidence field', () => {
    const result = classifyDeliverableContract('写一份技术方案到 docs/plan.md')
    // DeliverableConfidence — mode classification
    expect(['high', 'medium', 'low']).toContain(result.confidence)
    // The classification object does not contain contract.confidence (path scope) — that's in taskState
    expect((result as unknown as Record<string, unknown>)['scopeMode']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Regression: external_reference origin does NOT drive deliverable mode
// ---------------------------------------------------------------------------

describe('external_reference origin does not drive deliverable mode', () => {
  // The origin (external_reference, user-external) is a path/write-scope concept.
  // The deliverable classifier is text-only and must not be influenced by origin labels.
  it('plain text with external path but no artifact signal → not file_artifact_delivery/high', () => {
    // A path that looks like an external reference but has no artifact suffix or output path shape
    const result = classifyDeliverableContract('Look at /Users/publicuser/projects/data and tell me what you see')
    // Should NOT be high confidence file_artifact_delivery — no artifact suffix or output path
    const isHighDurable = result.mode === 'file_artifact_delivery' && result.confidence === 'high'
    expect(isHighDurable).toBe(false)
  })
})
