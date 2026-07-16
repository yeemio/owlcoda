# OwlFootball Structured Output Consumption Example

日期：2026-06-26
目的：展示 OwlFootball 如何消费 OwlCoda 的 Model Output Harness v1，而不是在业务侧驯模型输出。

## 1. 边界

OwlFootball 只负责业务 contract 和业务决策。

OwlCoda 负责：

- 调模型。
- 约束 preset/schema。
- parse / extract / repair / salvage。
- failed fallback。
- attempts/rawText 记账。

OwlFootball 不做：

- JSON repair。
- thinking_delta 转 artifact。
- provider 专用兜底。
- 把 `failed_fallback.v1` 当业务结论。

## 2. Evidence Digest Request

```ts
const response = await fetch("http://127.0.0.1:8019/v1/structured-output", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "kimi",
    preset: "owlfootball-evidence.v2",
    presetId: "owlfootball-evidence",
    presetVersion: "v2",
    schemaId: "owlfootball-evidence-contract",
    schemaVersion: "v2",
    schema: {
      type: "object",
      required: ["artifact", "summary", "confidence", "source_refs", "risks"],
      properties: {
        artifact: { const: "owlfootball-evidence.v2" },
        summary: { type: "string" },
        confidence: { type: "number" },
        source_refs: { type: "array", items: { type: "string" } },
        risks: { type: "array", items: { type: "string" } },
        data_gaps: { type: "array", items: { type: "string" } }
      }
    },
    system: "Return only a compact JSON object. No chain-of-thought.",
    user: evidenceText,
    maxTokens: 1200,
    repairPolicy: { enabled: true, maxAttempts: 1 },
    salvagePolicy: {
      enabled: true,
      fields: ["artifact", "summary", "confidence", "source_refs", "risks", "data_gaps"]
    },
    policy: {
      forbiddenPhrases: ["下注", "出票", "入串", "EV", "Kelly", "fair odds", "方向成立", "有价值", "无价值"]
    }
  })
})

const result = await response.json()
```

## 3. Consumption Rule

```ts
if (!result.ok || !result.schemaValid || result.artifact?.artifact === "failed_fallback.v1") {
  return {
    role: "evidence",
    status: "failed",
    retryRole: "evidence",
    failureArtifact: result.artifact,
    attempts: result.attempts,
    rawText: result.rawText
  }
}

return {
  role: "evidence",
  status: "ready",
  artifact: result.artifact,
  attempts: result.attempts
}
```

## 4. Role-level Rerun

如果 evidence digest 失败，只重跑 evidence digest：

```ts
await rerunRoleArtifact({
  role: "evidence",
  preset: "owlfootball-evidence.v2",
  previousAttempts: result.attempts
})
```

不要整场从头跑，也不要让 War Room 消费失败 artifact。

## 5. Provider Naming

业务代码可以选择 `model: "kimi"`、`model: "deepseek"` 或其它模型。

业务代码不应该创建 `kimi-evidence-digest` 这种 provider 专用 preset。使用 OwlCoda built-in contract 时，preset 是通用能力名：

- `evidence-digest.v1`
- `analyst-audit.v1`
- `canonical-judge.v1`

OwlFootball 传入自己的 schema 时必须使用自己的 custom preset（如上面的 `owlfootball-evidence.v2`），并显式提供独立 `schemaId/schemaVersion`、`system`、`policy` 和 `maxTokens`。`presetId/presetVersion` 可省略，由 preset 字符串 canonical 派生；若显式提供，则必须与派生值完全一致。built-in preset 与 caller custom schema 的混合请求会在调用模型前被拒绝。
