# OwlCoda

[English](README.md) · **中文**

> **你的模型、你的工具、你的数据 —— 本地运行，不登录，不上云。**

OwlCoda 是一个独立的、本地优先的 AI 编码工作台：原生终端 REPL，42+ 工具、
69+ slash 命令、会话持久化、技能学习，以及一层生产级中间件，全部跑在你自己
的机器上。**你用的每一个模型 —— 云端品牌也好，自己机器上的模型也好 —— 都在
同一个地方接入、统一治理：浏览器 Admin。**

**隐私默认。** 会话只落在本地 `~/.owlcoda/`。没有 OwlCoda 账号，也没有
OwlCoda 服务器。训练数据收集默认关闭（opt-in），落盘前先做 PII 脱敏，且永远
不上传。

## 一个控制面，管所有模型

`owlcoda admin` 打开一个浏览器控制台，你在这里接入任意模型，OwlCoda 负责路由
过去。云端品牌一键接入 —— Kimi、DeepSeek、GPT、Claude、Gemini、Grok、GLM、
MiniMax —— endpoint、默认模型、别名都按模板自动填好，贴上 key 就能用。其余的
—— 你自己机器上的模型，或任意自定义 OpenAI-/Anthropic-compatible endpoint ——
走自定义那条路。路由、fallback、健康、成本、审计，全在同一个控制台后面。

![在 OwlCoda Admin 里添加模型 —— 云端品牌一键，或自定义 / 本地 endpoint](assets/branding/admin-models.png)

## 安装

```bash
npm install -g owlcoda@latest
owlcoda            # 首跑时若没有可用模型，会进入配置路径
owlcoda admin      # 浏览器 Admin：配置本地 runtime 或云端 provider
```

前置条件：Node.js `>=20.19.0`（建议 22+），加一个 LLM 后端 —— 本地 runtime
（Ollama / LM Studio / vLLM / 任意 OpenAI-compatible endpoint）或一个云端
provider 的 API key。

全局 npm prefix 没有写权限时，用用户级 prefix：

```bash
npm config set prefix ~/.local && export PATH=~/.local/bin:$PATH
npm install -g owlcoda@latest
```

## 快速开始 —— 30 秒接 Ollama

从零开始，假设你完全没有配置过模型：

```bash
brew install ollama && ollama serve &
ollama pull qwen2.5-coder:7b
owlcoda init --endpoint http://127.0.0.1:11434/v1
owlcoda
```

LM Studio 用 `http://127.0.0.1:1234/v1`，vLLM 用 `http://127.0.0.1:8000/v1`。
云端 provider 在 `owlcoda admin` 里配。

### 图片与 Kimi K2.7

支持视觉输入的 OpenAI-compatible 模型可以在 REPL 里直接接收本地图片。你可以
粘贴本地图片路径、用 `@image.png` 插入，或写 Markdown 图片引用
`![shot](./shot.png)`；OwlCoda 会把图片转成 base64 多模态 content block 发送。
当前支持 `png`、`jpg`/`jpeg`、`webp`、`gif`。

Kimi K2.7 Code 走 Kimi API Platform / Moonshot 的 OpenAI-compatible 路由：
设置 `MOONSHOT_API_KEY`，或在 `owlcoda admin` 里添加 **Kimi K2.7 Code** provider，
然后用 `--model kimi27` 或 `--model kimi-k2.7-code`。

别一上来就让它改大项目。先在一个你熟悉的仓库里从只读任务开始，再给它一个
范围明确的小改动：

```bash
cd your-project
owlcoda -p "读一下这个项目，告诉我入口文件、测试命令和主要目录，不要修改文件"
```

## 它是什么

OwlCoda 站在你的模型和真实工程现场之间。模型可以动手，但每个动作都先过边界、
留下产物、被记录下来 —— 一个长期跑的 agent，不能只凭它一句"我做完了"就信。

- **自带模型。** 本地 runtime 和云端 provider 收进同一套模型 registry，
  带路由、fallback、重试、熔断和按模型超时。
- **原生 REPL。** 42+ 工具（Bash、Read/Write/Edit、Glob、Grep、Task、
  MCP 工具、agent 派发）和 69+ slash 命令，含会话持久化、搜索、标签、分支。
- **技能学习。** 复杂会话会被提炼成可复用技能，在相似任务里匹配回注入系统
  提示词。用 `owlcoda skills` 管理。
- **训练数据管线（opt-in）。** 会话可以打分、PII 脱敏、导出成本地 JSONL 供
  微调 —— 默认关闭，只写本地。
- **浏览器 Admin 与诊断。** `owlcoda admin` 配模型；`owlcoda doctor` /
  `health` / `audit` / `inspect` 做运行时诊断。

能力标签（`supported` / `partial` / `manual-only` / `unsupported`）声明在
[`src/capabilities.ts`](src/capabilities.ts)，与运行时实际行为对账保持诚实。

产品真相和分发边界见
[`docs/PRODUCT-TRUTH.md`](https://github.com/yeemio/owlcoda/blob/main/docs/PRODUCT-TRUTH.md)。

## 常用命令

```bash
owlcoda                          # 交互式 REPL（native）
owlcoda -m fast                  # 按 id / 别名 / 部分匹配选模型
owlcoda -p "list all .ts files"  # headless（非交互）
owlcoda init                     # 写出 config.json（自动检测模型）
owlcoda admin                    # 浏览器 Admin
owlcoda doctor [--json]          # 环境诊断；JSON 包含 build/schema identity
owlcoda models                   # 分层模型列表 + 路由探测
owlcoda --resume last            # 恢复上次会话
owlcoda skills                   # 列出已学习技能
owlcoda --help                   # 完整命令列表
```

## 配置

`owlcoda init` 会写出 `config.json`；完整字段见
[`config.example.json`](config.example.json)。如果平台 `catalog.json` 可达，
模型会自动加载，无需手写 `models` 数组。

```json
{
  "port": 8019,
  "models": [
    {
      "id": "qwen2.5-coder:32b",
      "backendModel": "qwen2.5-coder:32b",
      "endpoint": "http://127.0.0.1:11434/v1",
      "aliases": ["balanced", "default"],
      "default": true
    }
  ]
}
```

常用环境变量：

| 变量 | 作用 | 默认 |
|---|---|---|
| `OWLCODA_PORT` | 代理监听端口 | `8019` |
| `OWLCODA_HOME` | 数据目录 | `~/.owlcoda` |
| `OWLCODA_LOG_LEVEL` | 日志级别 | `info` |
| `OWLCODA_RENDER_MODE` | `safe`（每行重画，默认）或 `diff` | `safe` |

## 已知限制

- **transcript 滚轮回看** 在终端多路复用器（tmux/screen）下还没接上鼠标
  滚轮。app 内用 `PgUp` / `PgDn` / `Ctrl+↓` 或 `/history`。
- **`/cost` 的美元金额只是参考** —— 本地推理基本零成本，那个美元数是拿云端
  定价做横向对比，不是你的真实电费。
- **LSP 工具需要你自己装 language server**（如 `typescript-language-server`、
  `pyright`、`rust-analyzer`、`gopls`），通过 plugin 配置接入。
- **远程 OAuth 类 MCP server 暂不支持**；stdio MCP server（走 `.mcp.json`）
  完整可用。

## HTTP API

代理对外提供 Anthropic-compatible 的 `POST /v1/messages` 和 OpenAI-compatible
的 `POST /v1/chat/completions`，外加 `GET /v1/models`、`/metrics`（Prometheus）、
`/health` 和 `/openapi.json`。完整端点以 `GET /openapi.json` 为准。

## 许可证

从 `0.15.0` 边界起，OwlCoda 源码按 **`GPL-3.0-or-later`** 公开。商业、OEM、
嵌入式分发走维护者单独授权。

本仓库是 GPL 发行版的公开源码、issue、release 和信任入口。npm 包可能只携带
编译后的 `dist/`，对应源码要求见 [SOURCE.md](SOURCE.md)。历史已发布版本沿用
当时发布所附的许可证。

## 链接

- 官网：[owlcoda.com](https://owlcoda.com)
- Issues 与 PR：[github.com/yeemio/owlcoda/issues](https://github.com/yeemio/owlcoda/issues)
- 贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md) · 安全：[SECURITY.md](SECURITY.md)
- 示例项目：[世界杯预测器](demo/worldcup-predictor/README.md) —— 由 OwlCoda 编排的五角色模型辩论（侦查、视觉、正方、反方、裁判）

## 开发

```bash
npm run dev     # tsx 热加载
npm test        # 运行测试
npm run build   # TypeScript 编译
```
