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
  "schema": {
    "type": "object",
    "required": ["artifact", "summary", "confidence"],
    "properties": {
      "artifact": { "const": "evidence-digest.v1" },
      "summary": { "type": "string" },
      "confidence": { "type": "number" },
      "source_refs": { "type": "array", "items": { "type": "string" } },
      "risks": { "type": "array", "items": { "type": "string" } }
    }
  },
  "system": "Return only one JSON object. Do not include chain-of-thought.",
  "user": "Digest these evidence notes into a short artifact...",
  "maxTokens": 1200,
  "repairPolicy": { "enabled": true, "maxAttempts": 1 },
  "salvagePolicy": { "enabled": true, "fields": ["artifact", "summary", "confidence", "source_refs", "risks"] },
  "policy": {
    "forbiddenPhrases": ["下注", "出票", "入串", "EV", "Kelly", "fair odds"]
  }
}
```

## 4. 响应示例

```json
{
  "ok": true,
  "artifact": {
    "artifact": "evidence-digest.v1",
    "summary": "Short digest.",
    "confidence": 0.74,
    "source_refs": ["source:1"],
    "risks": []
  },
  "rawText": "{\"artifact\":\"evidence-digest.v1\",\"summary\":\"Short digest\",\"confidence\":0.74}",
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
  "artifact": {
    "artifact": "failed_fallback.v1",
    "ok": false,
    "failureReason": "empty_text_with_thinking",
    "model": "kimi",
    "preset": "evidence-digest.v1",
    "stopReason": "max_tokens",
    "inputTokens": 913,
    "outputTokens": 2048,
    "repairCount": 0,
    "salvageUsed": false,
    "retryHint": "rerun_role_artifact"
  },
  "rawText": "",
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

## 9. 与 P1-A/P1-B 的关系

- P1-A 解决“哪个模型具备 JSON/vision/tool/context 能力”。
- P1-C 解决“模型输出如何成为可靠 artifact”。
- P1-B 读取 P1-C 的 attempts/artifact，进入 scorecard/trajectory。

## 10. 当前 v1 限制

- v1 只支持 JSON object artifact。
- v1 schema validator 覆盖常用 JSON Schema 子集。
- v1 不做多轮 self-repair 模型调用，先做本地 repair/salvage。
- v1 endpoint 使用非流式模型调用。
- v1 不默认持久化 rawText；调用方可把响应写入 runtime artifact/ledger。
