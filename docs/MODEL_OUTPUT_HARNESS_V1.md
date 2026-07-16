# Model Output Harness v1

日期：2026-06-26
状态：P1-C implementation baseline

## 1. 定位

Model Output Harness v1 是 OwlCoda 的 provider-agnostic structured output 能力。

它不负责业务判断。它负责把模型输出收敛成可消费、可验证、可回放的 JSON artifact。

## 2. 为什么不叫 `kimi-*`

Kimi 只是一个可执行该能力的模型 profile，不是能力本身。

正确命名：

- `evidence-digest.v1`
- `analyst-audit.v1`
- `canonical-judge.v1`

错误命名：

- `kimi-evidence-digest`
- `deepseek-analyst-audit`
- `gpt-judge-canonical`

这样 OwlCoda 自己、OwlFootball、其它业务都能消费同一套能力。

## 3. 请求示例

```json
{
  "model": "kimi",
  "preset": "evidence-digest.v1",
  "system": "Return only one JSON object. Do not include chain-of-thought.",
  "user": "Digest these evidence notes into a short artifact...",
  "repairPolicy": { "enabled": true, "maxAttempts": 1 },
  "salvagePolicy": { "enabled": true, "fields": ["artifact", "summary", "confidence", "source_refs", "risks"] },
  "policy": {
    "forbiddenPhrases": ["下注", "出票", "入串", "EV", "Kelly", "fair odds"]
  }
}
```

Built-in preset 自带 canonical schema 和默认 policy，不能再与 caller custom schema 混用。resolver 按 `caller explicit override > matched provider matrix > built-in preset default` 生成 effective request；例如 Kimi/Moonshot 命中 `evidence-digest.v1` matrix 且未显式覆盖时使用 `maxTokens=20480` 及该 entry 的 temperature、timeout、locale。若 caller 显式传入 `maxTokens`、`temperature`、timeout 或 locale，则 caller 值优先，并在 provenance 中记录 `source=request`。

需要业务自定义 schema 时，改用 custom preset，并显式提供独立 `schemaId/schemaVersion`、`system`、`policy` 和 `maxTokens`。`presetId/presetVersion` 可省略并由 preset 字符串 canonical 派生；若显式提供则必须完全一致。完整示例见第 8 节链接。

## 4. 响应示例

```json
{
  "ok": true,
  "usable": true,
  "consumerReady": true,
  "artifact": {
    "artifact": "evidence-digest.v1",
    "summary": "简短的证据摘要。",
    "confidence": 0.74,
    "source_refs": ["source:1"],
    "risks": []
  },
  "rawText": "{\"artifact\":\"evidence-digest.v1\",\"summary\":\"简短的证据摘要。\",\"confidence\":0.74}",
  "salvage": {
    "used": false,
    "fields": {},
    "missingRequiredFields": [],
    "confidence": "high"
  },
  "artifactCompleteness": {
    "expected": ["artifact", "summary", "confidence"],
    "produced": ["artifact", "summary", "confidence"],
    "missing": [],
    "validationStatus": "pass",
    "fallbackStatus": "none",
    "artifactRefs": []
  },
  "consumerReadiness": {
    "consumerReady": true,
    "blockers": [],
    "warnings": [],
    "requiredArtifactsMissing": [],
    "fallbackUsed": false,
    "usable": true
  },
  "terminationKind": "completed",
  "presetId": "evidence-digest",
  "presetVersion": "v1",
  "schemaId": "evidence-digest",
  "schemaVersion": "v1",
  "repairPolicyVersion": "repair-policy.v1",
  "providerMatrixVersion": "provider-preset-matrix.v1",
  "providerMatrixProvenance": {
    "providerMatrixVersion": "provider-preset-matrix.v1",
    "providerMatrixEntryId": "provider-preset-matrix.v1/evidence-digest.v1/kimi",
    "providerMatrixEntryHash": "sha256:<deterministic-entry-hash>",
    "matched": true,
    "applied": true,
    "appliedControls": ["maxTokens", "temperature", "idleTimeoutMs", "hardTimeoutMs", "forceLocale"],
    "overrides": {},
    "controlSources": {
      "maxTokens": "provider_matrix",
      "temperature": "provider_matrix",
      "idleTimeoutMs": "provider_matrix",
      "hardTimeoutMs": "provider_matrix",
      "forceLocale": "provider_matrix"
    },
    "policyVersions": {
      "repairPolicy": "repair-policy.v1",
      "salvagePolicy": "salvage-policy.v1",
      "outputDiscipline": "json_only_no_cot_raw_preserved"
    }
  },
  "parsed": true,
  "schemaValid": true,
  "validationErrors": [],
  "attempts": [
    {
      "label": "primary",
      "model": "kimi",
      "durationMs": 932,
      "inputTokens": 412,
      "outputTokens": 108,
      "stopReason": "end_turn",
      "parsed": false,
      "schemaValid": false
    },
    {
      "label": "parse",
      "model": "kimi",
      "durationMs": 0,
      "inputTokens": 0,
      "outputTokens": 0,
      "stopReason": "end_turn",
      "parsed": true,
      "schemaValid": true
    }
  ],
  "repairCount": 0,
  "salvageUsed": false,
  "fallbackUsed": false,
  "stopReason": "end_turn",
  "inputTokens": 412,
  "outputTokens": 108,
  "durationMs": 932
}
```

## 5. Failure Contract

失败也必须返回 artifact：

```json
{
  "ok": false,
  "usable": false,
  "unusableReason": "empty_text_with_thinking",
  "consumerReady": false,
  "artifact": {
    "artifact": "failed_fallback.v1",
    "ok": false,
    "usable": false,
    "failureReason": "empty_text_with_thinking",
    "rawText": "",
    "rawThinkingText": "Long hidden reasoning without final JSON.",
    "model": "kimi",
    "preset": "evidence-digest.v1",
    "provider": "kimi",
    "stopReason": "max_tokens",
    "terminationKind": "completed",
    "inputTokens": 913,
    "outputTokens": 2048,
    "repairCount": 0,
    "repairUsed": false,
    "salvageUsed": false,
    "fallbackUsed": true,
    "createdAt": "2026-07-02T00:00:00.000Z",
    "retryHint": "rerun_role_artifact"
  },
  "rawText": "",
  "rawThinkingText": "Long hidden reasoning without final JSON.",
  "salvage": {
    "used": false,
    "fields": {},
    "missingRequiredFields": ["artifact", "summary", "confidence"],
    "confidence": "high",
    "reason": "empty_text_with_thinking"
  },
  "artifactCompleteness": {
    "expected": ["artifact", "summary", "confidence"],
    "produced": ["failed_fallback.v1"],
    "missing": ["artifact", "summary", "confidence"],
    "validationStatus": "fail",
    "fallbackStatus": "failed_fallback",
    "artifactRefs": []
  },
  "consumerReadiness": {
    "consumerReady": false,
    "blockers": [
      { "code": "failed_fallback", "message": "Structured output used failed fallback artifact" },
      { "code": "missing_required_artifact", "message": "Required artifact fields are missing" }
    ],
    "warnings": [],
    "requiredArtifactsMissing": ["artifact", "summary", "confidence"],
    "fallbackUsed": true,
    "usable": false
  },
  "terminationKind": "completed",
  "presetId": "evidence-digest",
  "presetVersion": "v1",
  "schemaId": "evidence-digest",
  "schemaVersion": "v1",
  "repairPolicyVersion": "repair-policy.v1",
  "providerMatrixVersion": "provider-preset-matrix.v1",
  "parsed": false,
  "schemaValid": false,
  "validationErrors": ["empty_text_with_thinking"],
  "attempts": [
    {
      "label": "primary",
      "model": "kimi",
      "durationMs": 12001,
      "inputTokens": 913,
      "outputTokens": 2048,
      "stopReason": "max_tokens",
      "parsed": false,
      "schemaValid": false,
      "error": "empty_text_with_thinking"
    },
    {
      "label": "fallback",
      "model": "kimi",
      "durationMs": 0,
      "inputTokens": 0,
      "outputTokens": 0,
      "stopReason": "max_tokens",
      "parsed": false,
      "schemaValid": false,
      "error": "empty_text_with_thinking"
    }
  ],
  "repairCount": 0,
  "salvageUsed": false,
  "fallbackUsed": true,
  "stopReason": "max_tokens",
  "inputTokens": 913,
  "outputTokens": 2048,
  "durationMs": 12001
}
```

## 6. JSON 收敛策略

处理顺序固定：

1. Full parse：整段文本就是 JSON object。
2. Extract：文本中提取第一个合法 JSON object。
3. Repair：补齐括号、数组、字符串闭合。
4. Salvage：从可识别片段抽取允许字段。
5. Fallback：结构化失败 artifact。

v1 的 repair 是轻量策略，不承诺任意坏 JSON 都能修好。

## 7. Policy 处理

policy 是调用方传入的输出纪律，不是 OwlCoda 的业务知识。

示例：

```json
{
  "policy": {
    "forbiddenPhrases": ["下注", "出票", "入串", "EV", "Kelly"],
    "maxArrayItems": 12,
    "maxStringLength": 1200
  }
}
```

命中 forbidden phrases 时，v1 默认返回 `schemaValid=false` 和 failed fallback，避免上层把违规结论当业务 artifact 消费。

## 8. OwlFootball 调用边界

完整示例见 [OwlFootball Structured Output Consumption Example](./examples/owlfootball-structured-output-example.md)。

OwlFootball 应该：

- 调用 `POST /v1/structured-output`。
- 传入业务 contract schema。
- 传入 forbidden phrase policy。
- 只消费 `ok=true && schemaValid=true` 的 `artifact`。
- 单角色失败时只重跑对应 role artifact。

OwlFootball 不应该：

- 自己 repair JSON。
- 自己解析 thinking_delta 当 artifact。
- 让 failed fallback 进入 War Room 裁决。
- 把 provider 名当能力名。

## 9. Execution economics

每个 response 和持久化 artifact 都提供独立计数：

```json
{
  "executionCounts": {
    "providerCalls": 1,
    "parseAttempts": 1,
    "repairAttempts": 0,
    "salvageAttempts": 0,
    "rerunAttempts": 0
  }
}
```

`parse`、local deterministic `repair`、`salvage` 不是 provider call；`/rerun` 是带 lineage 的新调用。
因此不能再用 attempts 数组长度近似 provider 成本，也不能把 `repairPolicy.maxAttempts` 扩写成模型重试次数。

显式 `Idempotency-Key`（或 body `idempotencyKey`）会在 provider 调用前建立 reservation。相同 key +
相同 canonical request 的并发与后续重复只执行一次；相同 key + 不同 request 返回 409。
Primary 与 `/rerun` 使用不同 namespace。无 key 的重复仍是合法新实验；调用方可用
`intentionalRepeat=true` 明确记录此意图，但它不能与 idempotency key 同时使用。
带 `persist/runRef` 的 key 会先把 hashed-key reservation 写入 RunWorkspace，再开始 provider call；完成
response 也持久化，因此 runtime 重启后仍可 replay。若进程在 provider 返回与 completion receipt 之间
中断，reservation 保持 `idempotency_in_progress` 并 fail closed，不能冒险重复付费调用；调用方可审计
原 RunWorkspace 后用新的 intentional key 或显式 `/rerun` lineage 继续。非持久请求的 key 只保证当前
runtime process 内的并发与重复合并。

任务级预算示例：

```json
{
  "persist": true,
  "runRef": "/path/to/output-root",
  "taskId": "task-evidence-20260710",
  "executionBudget": {
    "maxProviderCalls": 4,
    "maxInputTokens": 50000,
    "maxOutputTokens": 20000,
    "maxElapsedMs": 900000,
    "maxCostUsd": 0.75,
    "inputCostPerMillionUsd": 2.5,
    "outputCostPerMillionUsd": 10
  }
}
```

预算以 `runRef + taskId` 持久累计 primary 与 rerun。启用时必须同时提供 `persist=true`、`runRef`
和 `taskId`；同一任务中预算合同不可改变。provider call、保守 input token upper-bound、output token
上限和 caller-supplied USD 费率会在 upstream 前 reservation；elapsed 余量同时收紧 hard timeout。
OwlCoda 不会把本地参考估价冒充真实 provider price，因此 `maxCostUsd` 缺 caller 费率会被拒绝。

达到任一硬上限后，receipt 的 `status=exhausted`，RunWorkspace 写入
`execution-budget-stop-*.json` checkpoint，后续请求返回 HTTP 429 / typed
`task_budget_exhausted`，且不会调用 upstream。provider 最终报告的实际 token/cost 会替换 reservation；
若 provider 报告越界，本次 artifact 仍按其 schema truth 判定，但任务被标记 exhausted，禁止下一次调用。

## 10. 与 P1-A/P1-B 的关系

- P1-A 解决“哪个模型具备 JSON/vision/tool/context 能力”。
- P1-C 解决“模型输出如何成为可靠 artifact”。
- P1-B 读取 P1-C 的 attempts/artifact，进入 scorecard/trajectory。

## 11. 当前 v1 限制

- v1 只支持 JSON object artifact。
- v1 schema validator 覆盖常用 JSON Schema 子集。
- `/v1/structured-output` 会把 resolved 完整 schema 送入 provider：OpenAI-compatible Chat Completions 使用 `response_format.type=json_schema`，Anthropic Messages 使用 `output_config.format.type=json_schema`。本地递归校验仍保留为最终消费门。
- OpenAI-compatible wire 保持 `strict=false`，避免把 caller 当前允许的 optional fields 偷换成 strict subset；provider 输出仍必须通过原始 schema 的本地校验。
- provider 以 `max_tokens` 停止且 parse/repair/salvage 后仍不能形成有效 artifact 时，返回 typed `unusableReason=output_budget_exhausted`；完整或成功 repair/salvage 的结果不误判。
- v1 不做多轮 self-repair 模型调用，先做本地 repair/salvage。
- v1 activity-aware timeout is harness-level: executors that emit `onOutputDelta` get idle/hard timeout governance.
- The current `/v1/structured-output` HTTP provider executor remains non-streaming and does not emit provider deltas yet.
- Provider-level streaming delta integration is a follow-up slice before release intake can claim end-to-end provider activity awareness.
- v1 可持久化 rawText、attempt ledger、artifact completeness、consumer readiness 和 role/step rerun lineage。

## 12. Governance Extension

CLI Harness Governance P0/P1 的完整 contract 见 [CLI_HARNESS_GOVERNANCE_P0P1_CONTRACT_20260702.md](./specs/CLI_HARNESS_GOVERNANCE_P0P1_CONTRACT_20260702.md)。
