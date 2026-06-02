# 模型要求（Native Agent / REPL）

OwlCoda 默认是 **带大量 tools 的 coding agent**：原生 REPL 每轮会附带数十个
工具定义。这与在 Ollama、LM Studio 等里「和小模型随便聊两句」不是同一类产品。

本文适用于 **所有平台**（macOS、Linux、Windows），不是 Windows 专属限制。

## OwlCoda 需要什么

| 要求 | 原因 |
|------|------|
| **支持 tool / function calling** | 运行时必须接受带 `tools`（或等价）的聊天请求。 |
| **能扛多工具 Agent 负载** | 小模型可能“理论上支持 tools”，但实际延迟、质量或硬错误不可用。 |
| **`backendModel` 与运行时一致** | 如 `ollama list` 中的 `qwen2.5:7b`，不要只写展示用别名。 |

## 本地模型推荐（Agent / REPL）

| 档位 | 参数量 | 说明 |
|------|--------|------|
| **推荐** | **≥ 8B** | 本地 Agent 默认建议（如 `qwen2.5:7b`、`llama3.1:8b`、`qwen2.5-coder:7b`）。 |
| **实验下限** | **约 7B** | 在 GPU 机器上或可尝试；纯 CPU 不保证。 |
| **不支持 Agent** | **&lt; 7B**（1B～4B） | 可用于运行时直连聊天（`ollama run …`），**不要**用于 OwlCoda 原生 REPL。 |

常见 **不适合** Agent 的例子（Ollama）：

- `gemma3:1b`、`gemma2:2b` — 常 **不支持 tools** → 上游 `400` / “does not support tools”。
- `qwen2.5:1.5b`、`qwen3:4b` — 单独测可能能带 tools，但 **OwlCoda 全量 tool 负载** 在 CPU 上易触发代理超时，体感像“只有 OwlCoda 坏了”，而 `ollama run` 却很快。

## 云端

选用提供商文档标明支持 **tools / function calling** 的档位；同样区分「聊天小模型」与「Agent 模型」。

## 小于 8B 时怎么办

1. **要在 OwlCoda 里做 Agent** — 配置 **≥ 8B** 且支持 tools 的本地模型，或在 Admin 里用云端。
2. **只要本地轻量聊天** — 直接用运行时（`ollama run …`、LM Studio 界面等），不要用 `owlcoda` REPL。
3. **改完后验证** — `owlcoda doctor`、`owlcoda models`。

## 本地配置要点

```text
routerUrl     → 主机根地址，如 http://127.0.0.1:11434（末尾不要 /v1）
backendModel  → 与 ollama list / 运行时目录完全一致
models[]      → 至少一条；默认模型应符合上表档位
```

详见 [install.md](install.md)、[troubleshooting.md](troubleshooting.zh.md)。

## 产品说明（npm 包）

本公开路由仓描述 **应满足的期望**。在 Admin / `owlcoda doctor` 里强制最低档位（警告或拦截）属于 **npm 包产品改动**，可在 [GitHub Issues](https://github.com/yeemio/owlcoda/issues) 跟踪。
