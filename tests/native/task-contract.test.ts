import { describe, it, expect } from 'vitest'
import { classifyTaskContract } from '../../src/native/task-contract.js'
import {
  classifyDeliverableContract,
  shouldHardStopOnNoTouchedPaths,
  allowsChatFinal,
} from '../../src/native/deliverable-contract.js'

describe('classifyTaskContract — write_required (explicit file target)', () => {
  const cases: string[] = [
    'Write the engineering contract to docs/intake.md',
    'Fix the bug in src/native/conversation.ts',
    'edit src/foo.ts to add a new function',
    'create the file at src/bar.ts',
    'patch src/baz.ts with the fix',
    '写入 docs/intake.md 并落盘',
    '保存到 src/foo.ts',
    '修改 src/native/conversation.ts',
  ]
  for (const text of cases) {
    it(`'${text.slice(0, 50)}' → write_required high`, () => {
      const result = classifyTaskContract(text)
      expect(result).toEqual({ kind: 'write_required', confidence: 'high' })
    })
  }
})

describe('classifyTaskContract — read_only (negation/prohibition wins)', () => {
  const cases: string[] = [
    'Read-only audit and produce a report',
    'do not modify any files, give a final report',
    '只读查询，不允许创建、修改、删除 MES 数据，输出测试报告',
    '禁止改动，按以下结构输出报告',
    '只读访问，给出 10 条改进建议',
  ]
  for (const text of cases) {
    it(`'${text.slice(0, 50)}' → read_only high`, () => {
      const result = classifyTaskContract(text)
      expect(result).toEqual({ kind: 'read_only', confidence: 'high' })
    })
  }
})

describe('classifyTaskContract — text_deliverable (audit/report intent)', () => {
  const cases: string[] = [
    '审计 src/native/task-state.ts，给出 10 条改进建议',
    '审计代码，提出改进方向',
    '请给出这个文件的改进建议',
    'audit the codebase and give 10 improvement suggestions',
    'review the code and provide a summary',
    'output a final report with findings',
    '给出测试报告',
    'analyze the failure patterns',
    'evaluate the current architecture and recommend improvements',
  ]
  for (const text of cases) {
    it(`'${text.slice(0, 50)}' → text_deliverable high`, () => {
      const result = classifyTaskContract(text)
      expect(result).toEqual({ kind: 'text_deliverable', confidence: 'high' })
    })
  }
})

describe('classifyTaskContract — false-positive regression: 改 inside 改进/改善', () => {
  it('请给出改进代码风格的建议 → text_deliverable, NOT write_required', () => {
    const result = classifyTaskContract('请给出改进代码风格的建议')
    expect(result.kind).toBe('text_deliverable')
  })
  it('提出改善性能的方案建议 → text_deliverable via deliverable nouns', () => {
    const result = classifyTaskContract('提出改善性能的方案建议')
    expect(result.kind).toBe('text_deliverable')
  })
})

describe('classifyTaskContract — analytical architecture/code quality questions', () => {
  const cases: string[] = [
    '这个项目的 业务架构设计如何，代码写的是否健壮可扩展可维护',
    '这个项目的业务架构设计如何',
    '代码写得怎么样，是否可维护',
    '这个模块的实现是否稳定可靠',
    '后端抽象是否合理，后续是否容易扩展',
  ]
  for (const text of cases) {
    it(`'${text.slice(0, 50)}' → text_deliverable high`, () => {
      const result = classifyTaskContract(text)
      expect(result).toEqual({ kind: 'text_deliverable', confidence: 'high' })
    })
  }
})

describe('classifyTaskContract — mixed (low confidence)', () => {
  const cases: string[] = [
    '继续',
    '',
    '   ',
    'improve the code quality',
  ]
  for (const text of cases) {
    it(`'${text.slice(0, 50)}' → mixed low`, () => {
      const result = classifyTaskContract(text)
      expect(result).toEqual({ kind: 'mixed', confidence: 'low' })
    })
  }
})

describe('classifyTaskContract — explicit file target wins over audit', () => {
  it('audit X and write a fixed version to src/foo.ts → write_required', () => {
    const result = classifyTaskContract('audit src/foo.ts and write a fixed version to src/foo.ts')
    expect(result).toEqual({ kind: 'write_required', confidence: 'high' })
  })
})

describe('classifyTaskContract — canonical dogfood prompt', () => {
  // The exact prompt that hit task-no-progress hard-stop in v0.13.84 dogfood.
  const dogfoodPrompt = `你是 MES + OpenClaw 查询链路的探索式红队测试员。
你的目标不是验证某一个固定案例，而是先了解系统真实数据面，再模拟不同用户用各种自然语言问法来测试 OpenClaw 是否会：
- 查错维度
- 串单
- 复用旧答案
- 把接口错误当无数据
- 把全局分页当目标对象数据
- 臆造统计值
- 对用户问题过度推理

硬性限制：
- 只读查询，不允许创建、修改、删除 MES 数据。
- 不允许直接相信模型历史上下文，关键结论必须重新查询。
- 所有统计数字必须能追溯到接口、过滤条件和记录归属。
- 如果接口不支持某过滤条件，不能用该接口结果做目标对象统计。

请按以下结构输出报告：
1. 系统能力地图
2. 测试素材库
3. 测试覆盖情况
4. 问题清单
5. 最终结论`

  it('does NOT classify as write_required (the v0.13.84 false-positive)', () => {
    const result = classifyTaskContract(dogfoodPrompt)
    expect(result.kind).not.toBe('write_required')
  })
  it('classifies as read_only (explicit prohibition + structured output)', () => {
    const result = classifyTaskContract(dogfoodPrompt)
    expect(result.kind).toBe('read_only')
  })
})

describe('classifyTaskContract — 0.13.86 explicit-file-write within negation context', () => {
  it('"不允许修改 src/foo.ts" → read_only (was write_required pre-0.13.86)', () => {
    const result = classifyTaskContract('不允许修改 src/foo.ts')
    expect(result.kind).toBe('read_only')
  })
  it('"do not modify src/native/foo.ts" → read_only', () => {
    const result = classifyTaskContract('do not modify src/native/foo.ts in this task')
    expect(result.kind).toBe('read_only')
  })
  it('long meta-prompt with negation + path examples → read_only', () => {
    const prompt = '只读审计 OwlCoda。不允许修改 src/ 或 tests/ 任何文件。' +
      '判定标准 D：中文 write_required（修改 src/foo.ts、写入 docs/intake.md）。' +
      '请审计代码并提出改进建议。'
    const result = classifyTaskContract(prompt)
    expect(result.kind).toBe('read_only')
  })
  it('explicit file write OUTSIDE any negation still classifies as write_required', () => {
    const result = classifyTaskContract('Modify src/foo.ts to add a new export')
    expect(result.kind).toBe('write_required')
  })
})

describe('classifyTaskContract — 0.13.87 bare deliverable nouns + compound preservation', () => {
  it('"改进建议" alone → text_deliverable (was mixed pre-0.13.87)', () => {
    expect(classifyTaskContract('改进建议').kind).toBe('text_deliverable')
  })
  it('"改进方向" alone → text_deliverable (compound preserved by trimmed-pass)', () => {
    expect(classifyTaskContract('改进方向').kind).toBe('text_deliverable')
  })
  it('"改进方案" alone → text_deliverable', () => {
    expect(classifyTaskContract('改进方案').kind).toBe('text_deliverable')
  })
  it('"提出方案" → text_deliverable (方案 in noun list)', () => {
    expect(classifyTaskContract('提出方案').kind).toBe('text_deliverable')
  })
  it('"建议" alone → text_deliverable (bare noun branch)', () => {
    expect(classifyTaskContract('建议').kind).toBe('text_deliverable')
  })
  it('"给改进意见" → text_deliverable', () => {
    expect(classifyTaskContract('给改进意见').kind).toBe('text_deliverable')
  })
  it('regression: "Modify src/foo.ts" still write_required', () => {
    expect(classifyTaskContract('Modify src/foo.ts to add a new export').kind).toBe('write_required')
  })
  it('regression: "给出改进建议然后修改 src/foo.ts" → write_required (explicit file wins)', () => {
    expect(classifyTaskContract('给出改进建议然后修改 src/foo.ts').kind).toBe('write_required')
  })
})

// ---------------------------------------------------------------------------
// Slice 0 bridge tests (Deliverable Contract v1, 0.14.18+)
// ---------------------------------------------------------------------------

describe('Slice 0 bridge: taskHasWriteRequiredContract legacy wrapper semantics via deliverable contract', () => {
  it('file_artifact_delivery/high → shouldHardStopOnNoTouchedPaths true (equivalent to old write_required=true)', () => {
    const result = classifyDeliverableContract('Write the generated deck to docs/deck.html')
    expect(result.mode).toBe('file_artifact_delivery')
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(true)
  })

  it('code_change/high → shouldHardStopOnNoTouchedPaths true (equivalent to old write_required=true)', () => {
    const result = classifyDeliverableContract('Fix the bug in src/native/conversation.ts')
    expect(result.mode).toBe('code_change')
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(true)
  })

  it('read_only_review → allowsChatFinal true, shouldHardStopOnNoTouchedPaths false', () => {
    const result = classifyDeliverableContract('只读评审，在聊天中输出，不要求写文件')
    expect(allowsChatFinal(result)).toBe(true)
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(false)
  })

  it('text_deliverable → allowsChatFinal true, shouldHardStopOnNoTouchedPaths false', () => {
    const result = classifyDeliverableContract('写一份技术方案')
    expect(result.mode).toBe('text_deliverable')
    expect(allowsChatFinal(result)).toBe(true)
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(false)
  })

  it('mixed_unknown → allowsChatFinal true, shouldHardStopOnNoTouchedPaths false', () => {
    const result = classifyDeliverableContract('继续')
    expect(result.mode).toBe('mixed_unknown')
    expect(allowsChatFinal(result)).toBe(true)
    expect(shouldHardStopOnNoTouchedPaths(result)).toBe(false)
  })
})

describe('Slice 0 bridge: contract.confidence (path scope) is orthogonal to DeliverableConfidence (mode classification)', () => {
  it('classifyDeliverableContract returns DeliverableConfidence (mode) — not path scope confidence', () => {
    // The deliverable classifier has its own confidence scale independent of
    // the path/write-scope confidence in contract.confidence (ActiveTaskState).
    // Both should exist simultaneously without overwriting each other.
    const deliverable = classifyDeliverableContract('修改 src/native/conversation.ts 修复 bug')
    expect(deliverable.confidence).toBe('high') // mode-classification confidence
    // The task state's contract.confidence (path scope) is a separate field not present here
    expect((deliverable as unknown as Record<string, unknown>)['scopeMode']).toBeUndefined()
    expect((deliverable as unknown as Record<string, unknown>)['allowedWritePaths']).toBeUndefined()
  })

  it('external_reference origin does not appear in deliverable classification', () => {
    // The origin field (external_reference, user-external, workspace) lives in
    // the path scope layer (fs-policy / task-state). It must not bleed into
    // deliverable mode classification.
    const deliverable = classifyDeliverableContract(
      '修改 /Users/publicuser/external/project/src/foo.ts',
    )
    expect((deliverable as unknown as Record<string, unknown>)['origin']).toBeUndefined()
  })
})

describe('Slice 0 bridge: old classifyTaskContract kind still maps correctly to deliverable wrappers', () => {
  const writeRequiredCases = [
    'Write the engineering contract to docs/intake.md',
    'Fix the bug in src/native/conversation.ts',
    '修改 src/native/conversation.ts',
  ]
  for (const text of writeRequiredCases) {
    it(`old write_required → new deliverable shouldHardStop: '${text.slice(0, 50)}'`, () => {
      // Legacy: classifyTaskContract returns write_required
      const legacy = classifyTaskContract(text)
      expect(legacy.kind).toBe('write_required')
      // New: deliverable contract must also flag as hard-stop-eligible
      const deliverable = classifyDeliverableContract(text)
      expect(shouldHardStopOnNoTouchedPaths(deliverable)).toBe(true)
    })
  }

  const readOnlyCases = [
    '只读查询，不允许创建、修改、删除 MES 数据，输出测试报告',
    '审计 src/native/task-state.ts，给出 10 条改进建议',
  ]
  for (const text of readOnlyCases) {
    it(`old read_only/text_deliverable → new allowsChatFinal: '${text.slice(0, 50)}'`, () => {
      const legacy = classifyTaskContract(text)
      expect(['read_only', 'text_deliverable']).toContain(legacy.kind)
      const deliverable = classifyDeliverableContract(text)
      expect(allowsChatFinal(deliverable)).toBe(true)
    })
  }
})
