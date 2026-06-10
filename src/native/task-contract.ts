/**
 * Task contract classifier (Slice-E, 0.13.85+).
 *
 * Replaces the boolean `taskLikelyRequiresWrites` regex stack with a typed
 * classification: `{ kind, confidence }`. The classifier is pure-function:
 * no I/O, no module-level mutable state, deterministic for any input string.
 *
 * History: pre-Slice-E, three module-level regexes in `conversation.ts`
 * (`TASK_WRITE_INTENT_RE`, `TASK_NEGATED_WRITE_INTENT_RE`, `TASK_TEXT_DELIVERABLE_RE`)
 * collectively decided write-required vs not. The Chinese-language case
 * "审计 X，给出 N 条改进建议" tripped a false-positive: 改 (a substring of
 * 改进, "improvement") fired `TASK_WRITE_INTENT_RE`, the text-deliverable
 * regex didn't match 建议, and the negation regex needed an explicit prohibition
 * to strip the write intent — so a read-only audit prompt was classified as
 * write-required and hit `task-no-progress` hard-stop at iter 9.
 *
 * Slice 0 (Deliverable Contract v1, 0.14.18+):
 * New code should prefer `classifyDeliverableContract()` from
 * `./deliverable-contract.ts` and use its canonical wrappers:
 *   - isDurableArtifactDeliverable()
 *   - allowsChatFinal()
 *   - shouldCreateStructuredTaskPlan()
 *   - shouldHardStopOnNoTouchedPaths()
 *
 * `classifyTaskContract()` is preserved for backward compatibility — the
 * Slice 0 classifier delegates to it internally for `write_required` /
 * `read_only` / `text_deliverable` / `mixed` signal extraction.
 */

export type TaskContractKind =
  | 'write_required'
  | 'read_only'
  | 'text_deliverable'
  | 'mixed'

export type TaskContractConfidence = 'high' | 'low'

export interface TaskContractClassification {
  kind: TaskContractKind
  confidence: TaskContractConfidence
}

const TASK_WRITE_INTENT_RE = /\b(?:write|edit|patch|update|modify|create|add|implement|fix|rename|remove|delete|save|land|ship)\b|(?:写|改|修改|更新|补|新增|实现|修复|创建|生成|删除|落盘)/i

const TASK_NEGATED_WRITE_INTENT_RE = /(?:\b(?:read[- ]?only|no\s+mutations?|no\s+writes?|do\s+not|don't|never|must\s+not|not\s+allowed\s+to|without)\b[^.!?\n;；。！？]{0,120}\b(?:write|edit|patch|update|modify|create|add|implement|fix|rename|remove|delete|save|land|ship|writing|editing|patching|updating|modifying|creating|adding|implementing|fixing|renaming|removing|deleting|saving)\b)|(?:(?:只读|禁止|严禁|不(?:允许|能|要|可)|不能|不要|无需|无须|不用)[^.!?\n;；。！？]{0,120}(?:写|改|修改|更新|补|新增|实现|修复|创建|生成|删除|落盘))/gi

export const TASK_EXPLICIT_FILE_WRITE_TARGET_RE = /(?:\b(?:write|edit|patch|update|modify|create|add|implement|fix|rename|remove|delete|save|land|ship)\b[^.!?\n;；。！？]{0,100}\b(?:to|in|at|into)\s+[`'"]?(?:\.{0,2}\/|~\/|[A-Za-z0-9_.-]+\/)[^\s`'",;；。！？]+)|(?:(?:写入|写到|保存到|落到|落盘到|修改|更新|创建|新增|删除)[^.!?\n;；。！？]{0,100}[`'"]?(?:\.{0,2}\/|~\/|[A-Za-z0-9_.-]+\/|[A-Za-z0-9_.-]+\.(?:md|ts|tsx|js|jsx|json|py|yaml|yml|txt|css|html)))/i

const TASK_TEXT_DELIVERABLE_RE = /(?:按(?:以下|如下)[^。！？\n.!?]{0,40}输出|输出[^。！？\n.!?]{0,40}(?:报告|表格|清单|问题|结论|摘要|总结|提示词|prompt|建议|改进建议|改进方向|改进意见|改进方案|改进思路|意见|反馈|方案|思路|方向|评估|评价|分析|审计报告)|(?:给出|列出|整理|总结|起草|撰写|提出|生成)[^。！？\n.!?]{0,40}(?:报告|表格|清单|问题|结论|摘要|总结|提示词|prompt|建议|改进建议|改进方向|改进意见|改进方案|改进思路|意见|反馈|方案|思路|方向|评估|评价|分析|审计报告)|(?:^|[\s，。、；：])(?:改进建议|改进方向|改进意见|改进方案|改进思路|审计报告|建议|意见|反馈)(?=$|[\s，。、；：])|\b(?:output|return|provide|give|draft|generate|propose|suggest|recommend)\b[^.!?\n]{0,80}\b(?:report|table|list|questions?|summary|conclusion|prompt|final answer|suggestions?|recommendations?|feedback|assessment|evaluation|analysis|findings?|improvements?)\b|\b(?:final report|final answer)\b)/i

const TASK_AUDIT_INTENT_RE = /(?:审计|评估|评价|分析|审查|红队)|(?:red[\s-]?team|audit|review|assess|evaluate|analyze|inspect)\b/i

const TASK_ANALYSIS_QUESTION_RE = /(?:(?:架构|设计|代码|实现|模块|系统|业务|后端|前端|链路|抽象|接口|模型|引擎|项目)[^。！？\n.!?]{0,80}(?:如何|怎么样|是否|是不是|能否|可否|健壮|可扩展|可维护|合理|清晰|稳定|可靠))|(?:(?:如何|怎么样|是否|是不是|能否|可否)[^。！？\n.!?]{0,80}(?:架构|设计|代码|实现|健壮|可扩展|可维护|合理|清晰|稳定|可靠))/i

const TASK_WRITE_COMPOUND_EXCLUSION_RE = /改(?:进|善|良)|补(?:充|足|救)|修(?:养)|写(?:的|得|法)/g

const READ_ONLY_PROHIBITION_RE = /\b(?:read[- ]?only|do not modify|do not write|do not create|do not delete|no writes?|no mutations?)\b|只读(?:查询|访问|模式)?|禁止(?:写|改|修改|更新|创建|生成|删除|落盘)|严禁(?:写|改|修改|创建|删除)|不(?:允许|能|要|可)\s*(?:写|改|修改|更新|补|新增|实现|修复|创建|生成|删除|落盘)/i

function stripNegatedWriteClauses(text: string): string {
  return text.replace(TASK_NEGATED_WRITE_INTENT_RE, ' ')
}

function stripWriteCompoundNouns(text: string): string {
  return text.replace(TASK_WRITE_COMPOUND_EXCLUSION_RE, ' ')
}

export function classifyTaskContract(text: string): TaskContractClassification {
  const trimmed = text.trim()
  if (trimmed === '') {
    return { kind: 'mixed', confidence: 'low' }
  }

  const auditIntent = TASK_AUDIT_INTENT_RE.test(trimmed)
  const readOnlyProhibition = READ_ONLY_PROHIBITION_RE.test(trimmed)

  const stripped = stripWriteCompoundNouns(stripNegatedWriteClauses(trimmed))
  // 0.13.86: evaluate on stripped so '不允许修改 src/foo.ts' doesn't trip
  const explicitFileWrite = TASK_EXPLICIT_FILE_WRITE_TARGET_RE.test(stripped)
  const writeIntentSurvives = TASK_WRITE_INTENT_RE.test(stripped)
  // 0.13.87: test on both trimmed and stripped. Compound deliverable nouns
  // (改进方向, 改进方案) need 改进 visible (lost in stripping); bare 建议
  // needs strip pass to remove confusing prefixes. Either match wins.
  const textDeliverable =
    TASK_TEXT_DELIVERABLE_RE.test(trimmed) ||
    TASK_TEXT_DELIVERABLE_RE.test(stripped) ||
    TASK_ANALYSIS_QUESTION_RE.test(trimmed) ||
    TASK_ANALYSIS_QUESTION_RE.test(stripped)

  // 0.13.86: read-only prohibition wins over explicit_file_write so meta-
  // prompts ('只读审计 ... write_required examples: 修改 src/foo.ts') aren't
  // misclassified by inline example paths in non-negated illustrative context.
  if (readOnlyProhibition) {
    return { kind: 'read_only', confidence: 'high' }
  }
  if (explicitFileWrite) {
    return { kind: 'write_required', confidence: 'high' }
  }
  if (auditIntent) {
    return { kind: 'text_deliverable', confidence: 'high' }
  }
  if (textDeliverable) {
    return { kind: 'text_deliverable', confidence: 'high' }
  }
  if (writeIntentSurvives) {
    return { kind: 'write_required', confidence: 'high' }
  }
  return { kind: 'mixed', confidence: 'low' }
}
