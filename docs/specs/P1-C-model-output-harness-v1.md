# P1-C Spec: Model Output Harness v1

日期：2026-06-26
优先级：P1
依赖：P1-A Capability-aware Model Routing，P0-A Runtime Truth Spine，P0-C App Server Protocol baseline

## 1. 目标

把“模型输出能不能被上层稳定消费”做成 OwlCoda 的通用 runtime 能力。

核心问题：

> 上层业务不应该反复处理模型长推理、JSON 不闭合、自然语言夹杂、max_tokens 截断、空 text/thinking-only、失败 fallback 和 attempts 记账。

OwlCoda 要提供一个 provider-agnostic 的 structured output harness，让调用方按 `schema/preset/model` 请求模型，并稳定拿到可验证 JSON artifact。

## 2. 产品边界

OwlCoda 负责：

- schema 约束。
- preset 输出纪律。
- JSON parse / extract / repair / salvage。
- raw text / thinking 归档字段。
- attempts 记账。
- policy validation。
- 标准 fallback artifact。
- role/artifact 级别重跑所需的稳定 request/output contract。

OwlCoda 不负责：

- 业务判断。
- 足球、股票、下注、出票等业务语义。
- provider 专用产品能力命名。
- 默认把失败轨迹送进训练。
- 用自由文本替代 artifact。

## 3. 命名规则

preset 必须是能力名，不是模型名。

第一批 preset：

| Preset | 目的 | 模型关系 |
| --- | --- | --- |
| `evidence-digest.v1` | 把长证据压成短 JSON artifact | 可由 Kimi、DeepSeek、GPT、本地模型等执行 |
| `analyst-audit.v1` | 消费已压缩 artifact，输出候选、冲突、缺口 | 不重读长证据 |
| `canonical-judge.v1` | 消费压缩证据和争点，输出规范裁决 JSON | 不重新抓网页，不重读长证据 |

Kimi / DeepSeek / GPT / Qwen / local 模型只属于 model profile 或 route，不出现在 preset 名里。

## 4. API Contract

入口：

- `POST /v1/structured-output`
- 内部 TypeScript API：`runStructuredOutput(...)`

请求字段：

```ts
type StructuredOutputRequest = {
  model: string;
  preset?: "evidence-digest.v1" | "analyst-audit.v1" | "canonical-judge.v1" | string;
  schema?: JsonSchema;
  system?: string;
  user: string;
  maxTokens?: number;
  repairPolicy?: {
    enabled?: boolean;
    maxAttempts?: number;
  };
  salvagePolicy?: {
    enabled?: boolean;
    fields?: string[];
  };
  policy?: {
    forbiddenPhrases?: string[];
    maxArrayItems?: number;
    maxStringLength?: number;
  };
};
```

响应字段：

```ts
type StructuredOutputResponse = {
  ok: boolean;
  artifact: Record<string, unknown>;
  rawText: string;
  parsed: boolean;
  schemaValid: boolean;
  validationErrors: string[];
  attempts: StructuredOutputAttempt[];
  repairCount: number;
  salvageUsed: boolean;
  fallbackUsed: boolean;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
};

type StructuredOutputAttempt = {
  label: "primary" | "parse" | "repair" | "salvage" | "fallback";
  model: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
  parsed: boolean;
  schemaValid: boolean;
  error?: string;
};
```

## 5. JSON 处理顺序

按以下顺序处理模型输出：

1. 解析完整 JSON object。
2. 如果前后夹杂自然语言，抽取第一个合法 JSON object。
3. 如果 JSON 不闭合，按 repair policy 尝试一次补闭合。
4. 如果 repair 失败，按 salvage policy 抽取可识别字段。
5. 如果 text 为空但存在 thinking/reasoning，只记录 raw/thinking，返回标准 failed fallback。
6. 如果全部失败，返回标准 failed fallback，不返回空字符串。

## 6. Preset Contract

### `evidence-digest.v1`

用途：把长输入变成短、可消费、可验证的 evidence artifact。

约束：

- 单层 JSON object 优先。
- 禁止 chain-of-thought / 长推理展开。
- 限制数组数量和每条长度。
- 业务执行话术必须走 policy，而不是写死在 OwlCoda。
- `stopReason=max_tokens` 且已有部分 JSON 时，优先 repair/salvage。

建议字段：

```json
{
  "role": "evidence_digest",
  "artifact": "evidence-digest.v1",
  "summary": "",
  "confidence": 0,
  "source_refs": [],
  "evidence_items": [],
  "source_quality": "",
  "risks": [],
  "data_quality": "",
  "market_coverage": "",
  "data_gaps": []
}
```

### `analyst-audit.v1`

用途：消费 evidence artifact，输出候选方向、冲突和证据缺口。

约束：

- 不重读长证据。
- 不做最终裁决。
- 输入必须引用 evidence artifact id 或 artifact payload。
- 输出必须显式列出 conflicts / gaps / assumptions。

### `canonical-judge.v1`

用途：消费压缩证据、争点、baseline、市场结构，输出 canonical judge JSON。

约束：

- 不重新抓网页。
- 不重读长证据。
- 失败时只返回 judge failed artifact。
- 不把自然语言结论当 artifact。

## 7. Attempts 记账

每个阶段都要进入 `attempts`：

- primary：模型原始响应。
- parse：完整 parse 或 JSON object extract。
- repair：补闭合或轻量 JSON repair。
- salvage：字段级 salvage。
- fallback：标准失败 artifact。

attempts 不能只记录最终结果，必须能解释为什么某次输出被拒绝、修复或降级。

## 8. Fallback Artifact

失败时必须返回结构化 artifact：

```json
{
  "artifact": "failed_fallback.v1",
  "ok": false,
  "failureReason": "parse_failed",
  "model": "model-id",
  "preset": "evidence-digest.v1",
  "stopReason": "max_tokens",
  "inputTokens": 0,
  "outputTokens": 0,
  "repairCount": 0,
  "salvageUsed": false,
  "retryHint": "rerun_role_artifact"
}
```

不允许返回空字符串或无字段 object。

## 9. 单角色重跑

OwlCoda contract 必须支持上层按 role/artifact 重跑：

- evidence 失败只重跑 evidence artifact。
- analyst 失败只重跑 analyst artifact。
- judge 失败只重跑 judge artifact。
- 不要求上层整场从头开始。

v1 先保证 request/response 可定位 role/preset/model/attempts；artifact store 和业务侧重跑编排属于后续 slice。

## 10. 验收标准

必须覆盖：

1. 完整 JSON：`ok=true`, `parsed=true`, `schemaValid=true`。
2. JSON 前后夹杂自然语言：能抽取 JSON。
3. `max_tokens` 截断但有可修复 JSON：repair/salvage 后返回 artifact。
4. 空 text 但有 thinking：返回 failed fallback，不返回空字符串。
5. 命中 forbidden phrases：返回 validation error 或净化为风险，不能让业务当结论消费。
6. `analyst-audit.v1` 不要求重读长证据，只消费 artifact。
7. `canonical-judge.v1` 失败时只返回 judge failed artifact。
8. 所有失败路径都有 attempts 和 rawText，可回放。
9. 现有 `/v1/messages` 行为不被破坏。

## 11. 交付物

- `docs/MODEL_OUTPUT_HARNESS_V1.md`
- `src/model-output-harness.ts`
- `src/endpoints/structured-output.ts`
- `POST /v1/structured-output` OpenAPI 和 api-info 入口。
- focused tests。
- OwlFootball 调用示例，强调只消费 artifact，不在业务侧驯模型。

## 12. 执行 Prompt

```text
你是 OwlCoda Model Output Harness 执行 agent。目标是完成 P1-C Model Output Harness v1。

先读：
1. docs/specs/README.md
2. docs/specs/STAGE_SPEC_MATRIX.md
3. docs/specs/P1-C-model-output-harness-v1.md
4. docs/MODEL_OUTPUT_HARNESS_V1.md
5. src/model-registry.ts
6. src/endpoints/messages.ts
7. src/endpoints/chat-completions.ts

硬规则：
1. preset 必须 provider-agnostic，不能叫 kimi-*、deepseek-*、gpt-*。
2. Kimi/DeepSeek/GPT/Qwen/local 只是 model profile 或 route。
3. OwlCoda 只保证模型输出成为可靠 artifact，不写业务裁决逻辑。
4. JSON 处理顺序必须是 parse -> extract -> repair -> salvage -> fallback。
5. fallback 必须结构化，不能返回空字符串。
6. attempts 必须记录 primary/parse/repair/salvage/fallback。
7. /v1/messages 不能被破坏。
8. 最终给出测试命令、示例 payload、剩余风险。
```
