# OwlCoda

[English](README.md) · [中文](README.zh.md)

> **你的模型、你的工具、你的数据。一个让你自由编排模型机队的编码工作台。**

OwlCoda 是一个独立的、本地优先的 AI 编码工作台。它以 native 终端
REPL 形态运行，内置 42+ 工具与 69+ slash 命令，对外接受 Messages
形态的 API 请求，对内把请求路由到任意 OpenAI 兼容的本地 runtime
或者你自己配置的云端 provider。

> **隐私默认值。** 所有会话只落到本地 `~/.owlcoda/`。训练数据收集
> **默认关闭**，开启需要显式 opt-in，落盘前会经过 PII 脱敏。
> OwlCoda 没有自己的服务器，没有 telemetry 端点，没有上传。

当前是 **Developer Preview**，CLI 形态、slash 命令集、配置 schema
在 1.0 之前可能继续演进。

---

## 支持的 backend

OwlCoda 不自带模型——你把它指到一个上面去。开箱即支持以下后端：

### 本地 runtime（`owlcoda init` 自动探测）

| Runtime | 默认 endpoint |
|---|---|
| [Ollama](https://ollama.com) | `http://127.0.0.1:11434/v1` |
| [LM Studio](https://lmstudio.ai) | `http://127.0.0.1:1234/v1` |
| [vLLM](https://github.com/vllm-project/vllm) | `http://127.0.0.1:8000/v1` |
| 任意自建 OpenAI 兼容 router | 用户自填 |

### 云端 provider（用户自配置，自带 API key）

| Provider | 协议形态 | Endpoint |
|---|---|---|
| Kimi (Moonshot) | OpenAI 兼容 | `https://api.moonshot.ai/v1` |
| Kimi Coding | provider 原生 | `https://api.kimi.com/coding` |
| MiniMax | Messages 形态 | `https://api.minimaxi.com/anthropic` |
| OpenRouter | OpenAI 兼容 | `https://openrouter.ai/api/v1` |
| 阿里百炼 / DashScope | OpenAI 兼容 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| OpenAI | OpenAI 兼容 | `https://api.openai.com/v1` |
| 用户自配 Messages 形态 provider | Messages 形态 | 用户自填 |
| 其他 | OpenAI 兼容 / Messages 形态 | 用户自填 |

Provider 模板源码在
[`src/provider-probe.ts`](src/provider-probe.ts)，在 `config.json`
里加 model 条目即可覆盖或新增。

---

## 安装 OwlCoda

OwlCoda 当前以源码形式分发。npm / Homebrew / 独立二进制将在 1.0
之后提供。

```bash
git clone https://github.com/yeemio/owlcoda.git
cd owlcoda
npm install
npm run build
npm link             # 之后 `owlcoda` 全局可用
```

前置条件：Node.js ≥ 18（推荐 Node 20+），macOS / Linux /
Windows-WSL。

如果 `npm link` 因为全局 npm prefix 没写权限而失败：

- `sudo npm link`，**或**
- `npm config set prefix ~/.local && export PATH=~/.local/bin:$PATH`，
  然后再 `npm link`，**或**
- 完全不做 link，直接 `node /path/to/owlcoda/dist/cli.js …`。

---

## 配置你的第一个 backend

`owlcoda init` 会写出一份起步 `config.json`。它会自动探测上面那几个
端口上是否已经有本地 runtime 在跑；如果都没响应，就写一份占位让你
手动编辑。

也可以用 `--router` 显式指定。下面给几个常见场景示例。

### 本地：Ollama

```bash
owlcoda init --router http://127.0.0.1:11434/v1
owlcoda
```

### 本地：LM Studio

```bash
owlcoda init --router http://127.0.0.1:1234/v1
owlcoda
```

### 云端：Kimi (Moonshot)

```bash
export KIMI_API_KEY=sk-...
owlcoda init --router https://api.moonshot.ai/v1
```

然后编辑 `config.json` 把 key 接上：

```json
{
  "routerUrl": "https://api.moonshot.ai/v1",
  "models": [
    {
      "id": "kimi-k2",
      "label": "Kimi K2",
      "backendModel": "moonshot-v1-128k",
      "endpoint": "https://api.moonshot.ai/v1",
      "apiKeyEnv": "KIMI_API_KEY",
      "aliases": ["default", "kimi"],
      "default": true
    }
  ]
}
```

### 云端：MiniMax（Messages 形态）

```json
{
  "routerUrl": "https://api.minimaxi.com/anthropic",
  "models": [
    {
      "id": "minimax-m27",
      "label": "MiniMax M2.7-highspeed",
      "backendModel": "MiniMax-M2.7-highspeed",
      "endpoint": "https://api.minimaxi.com/anthropic",
      "apiKeyEnv": "MINIMAX_API_KEY",
      "localRuntimeProtocol": "anthropic_messages",
      "aliases": ["default", "minimax"],
      "contextWindow": 204800,
      "default": true
    }
  ]
}
```

### 云端：OpenRouter（多模型网关）

```json
{
  "routerUrl": "https://openrouter.ai/api/v1",
  "models": [
    {
      "id": "openrouter-default",
      "label": "OpenRouter selection",
      "backendModel": "qwen/qwen3-coder",
      "endpoint": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "aliases": ["default"],
      "default": true
    }
  ]
}
```

### 混合本地 + 云端（一份 config 多个模型）

可以在一份 config 里列任意多模型，本地与云端混跑，运行时通过
`--model <alias>` 或在 REPL 里 `/model` 切换：

```json
{
  "routerUrl": "http://127.0.0.1:11434/v1",
  "models": [
    { "id": "qwen-local", "backendModel": "qwen2.5-coder:7b",
      "aliases": ["default", "fast"], "default": true },
    { "id": "kimi-cloud", "backendModel": "moonshot-v1-128k",
      "endpoint": "https://api.moonshot.ai/v1",
      "apiKeyEnv": "KIMI_API_KEY",
      "aliases": ["heavy", "kimi"] }
  ]
}
```

`owlcoda --model heavy` → Kimi。默认 → 本地 Qwen。

完整 schema 见 [`config.example.json`](config.example.json)；能力声明
真值见 [`src/capabilities.ts`](src/capabilities.ts)（runtime 验证过
的能力清单）。

---

## 常用命令

```bash
owlcoda                          # 默认进入 native 交互式 REPL
owlcoda -p "list all .ts files"  # 非交互模式 (headless one-shot)
owlcoda --resume last            # 恢复上次会话
owlcoda --model <alias>          # 选择模型

owlcoda init                     # 创建 config.json
owlcoda doctor                   # 环境与 backend 健康检查
owlcoda config                   # 查看当前配置 + 已解析模型
owlcoda models                   # 列出已配置模型 + 可达性

owlcoda start | stop | status    # 后台 daemon 生命周期
owlcoda clients                  # 列出 / 解绑活跃 REPL 客户端
owlcoda ui --open-browser        # 启动 browser admin

owlcoda skills [list|show|synth|search|match|stats|export|import]
owlcoda training [status|scan|report|export jsonl|sharegpt|insights]
owlcoda audit | cache | logs | inspect | benchmark | health | validate
```

`owlcoda --help` 列出全部命令，按职能分组。

---

## 配置参考

环境变量覆盖：

| 变量 | 作用 | 默认值 |
|---|---|---|
| `OWLCODA_PORT` | OwlCoda HTTP 端口 | `8019` |
| `OWLCODA_ROUTER_URL` | Backend router URL | 来自 `config.json` |
| `OWLCODA_HOME` | 数据目录 | `~/.owlcoda` |
| `OWLCODA_LOG_LEVEL` | 日志级别 | `info` |
| `OWLCODA_TRAINING_COLLECTION` | `0` / `1`（覆盖 config） | 未设置 |

`config.json` 的每个 model 常用字段：

| 字段 | 用途 |
|---|---|
| `id` | API 中使用的稳定 model id |
| `label` | UI 显示用的友好名 |
| `backendModel` | backend 自身识别的 model id |
| `endpoint` | 这一个 model 单独覆盖 `routerUrl` |
| `apiKey` / `apiKeyEnv` | 云端凭据（直接值或 env var 名） |
| `localRuntimeProtocol` | `auto` / `openai_chat` / `anthropic_messages` |
| `aliases` | `--model` 可用的别名 |
| `tier` | `fast` / `balanced` / `heavy`（UI 分组） |
| `default` | 一份 config 里有一个默认 model |

---

## Native REPL 亮点

- **42+ 工具** —— Bash、Read、Write、Edit、Glob、Grep、MCP 工具、
  agent dispatch、scheduling、plugin 等。
- **69+ slash 命令** —— `/model`、`/cost`、`/budget`、`/perf`、
  `/doctor`、`/config`、`/trace`、`/tokens`、`/sessions`、`/skills`、
  `/dashboard` 等；REPL 内 `/help` 列全部。
- **Selection-first transcript** —— 鼠标拖选与复制和其他终端 app
  完全一致。
- **会话持久化** —— 每次对话都自动落到 `~/.owlcoda/sessions/`，
  `--resume <id>` 可恢复任意一次。
- **技能学习 (L2)** —— 重复任务被自动提取为可复用 skill，
  在后续匹配任务上自动注入。
- **训练数据管线 (L3，opt-in)** —— 对高质量会话评分，导出
  JSONL / ShareGPT，便于本地微调。

---

## 架构（简版）

```
owlcoda CLI (src/cli.ts → src/cli-core.ts)
  → native REPL (src/native/)
    → 42+ 工具 + 69+ slash 命令
      → OwlCoda HTTP server (src/server.ts)
        → 协议翻译 (Messages-shaped API ↔ OpenAI Chat Completions)
          → 你的本地 runtime (Ollama / LM Studio / vLLM / 自建)
              + 你配置的云端 provider (Kimi / MiniMax /
                OpenRouter / OpenAI / Bailian / 用户自填 / …)
```

顶层目录：`src/`（运行时）、`admin/`（browser admin React app）、
`skills/`（精选方法论 skill pack）、`scripts/`（smoke / build 脚本）、
`tests/`（vitest 套件）。

---

## 开发

```bash
npm run dev      # 通过 tsx 直接跑 src/cli.ts（无需 rebuild）
npm test         # vitest 套件（~3450 tests，~30s）
npm run build    # tsc → dist/，并 chmod +x dist/cli.js
npm run smoke    # 对真实后端做完整 smoke 测试
```

参见 [`CONTRIBUTING.zh.md`](CONTRIBUTING.zh.md) 了解开发环境搭建、
代码规范与 PR 提交流程。

---

## 隐私态势

- 所有会话数据、学习的 skill 以及（若启用）训练数据，全部在你
  本机的 `~/.owlcoda/` 下。
- 训练数据管线在 [`src/data/sanitize.ts`](src/data/sanitize.ts)
  做 PII 脱敏，所有记录在追加到 `~/.owlcoda/training/collected.jsonl`
  之前都会过这一层。
- OwlCoda 没有 telemetry 端点，也不会发起任何超出你 `config.json`
  里配置范围的外部请求。

---

## License

Apache License 2.0，见 [`LICENSE`](LICENSE) 与 [`NOTICE.md`](NOTICE.md)。

OwlCoda 在 `src/ink/` 下集成了一份基于
[vadimdemedes/ink](https://github.com/vadimdemedes/ink) (MIT) 的 fork。
原作者 Vadim Demedes 的 MIT copyright 完整保留在
[`NOTICE.md`](NOTICE.md) 与 [`src/ink/ATTRIBUTION.md`](src/ink/ATTRIBUTION.md)
中，每次 `npm publish` 的 tarball 也会带上 `dist/ink/ATTRIBUTION.md`。

---

## 贡献与反馈

- 问题与功能请求：本仓库的 GitHub Issues。
- 如果要提交较大改动，先看
  [`CONTRIBUTING.zh.md`](CONTRIBUTING.zh.md) ——
  代码库迭代很快，先开 issue 对齐方向能省双方时间。
- 安全相关报告：见 [`SECURITY.md`](SECURITY.md)。
