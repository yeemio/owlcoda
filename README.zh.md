# OwlCoda

[English](README.md) · [中文](README.zh.md)

> **你的模型、你的工具、你的数据 —— 本地运行，不登录，不上云。**

OwlCoda 是一个独立的、本地优先的 AI 编码工作台。一个 native 终端 REPL，
内置 42+ 工具、69+ slash 命令、会话持久化、技能学习与注入、生产级中间件
—— 全部跑在你自己的机器上。支持 Ollama、LM Studio、vLLM 等任意
OpenAI 兼容的本地 runtime，以及你自己配置的可选云端 provider。

> **隐私默认值。** 所有会话只落到本地 `~/.owlcoda/`。训练数据收集
> **默认关闭**，开启需要显式 opt-in，落盘前会经过 PII 脱敏。OwlCoda
> 不向任何远端上传数据 —— 因为根本没有 OwlCoda 的服务器。

当前是 **Developer Preview**，CLI 形态、slash 命令集、配置 schema
在 1.0 之前可能继续演进。

---

## 30 秒跑通（以 Ollama 为例）

零知识用户最短路径，假设你**完全没有任何模型 / runtime**：

```bash
# 1. 一个本地模型后端（Ollama 是最便宜的路径）
brew install ollama && ollama serve &
ollama pull qwen2.5-coder:7b

# 2. OwlCoda 本体（当前形态：仅源码安装；npm / Homebrew /
#    独立二进制计划在 1.0 之后提供）
git clone https://github.com/yeemio/owlcoda.git
cd owlcoda
npm install
npm run build
npm link            # 之后 `owlcoda` 全局可用

# 3. 让 OwlCoda 对接本地后端并启动
owlcoda init --router http://127.0.0.1:11434/v1
owlcoda
```

LM Studio 用户：把 `--router` 改成 `http://127.0.0.1:1234/v1`。
vLLM 用户：`http://127.0.0.1:8000/v1`。任何 OpenAI 兼容端点都可。

如果 `npm link` 因为全局 npm prefix 没写权限而失败：

- `sudo npm link`，**或**
- `npm config set prefix ~/.local && export PATH=~/.local/bin:$PATH`
  之后再 `npm link`，**或**
- 完全不做 link，直接 `node /path/to/owlcoda/dist/cli.js`。

---

## 前置条件

- Node.js ≥ 18（推荐 Node 20+）。
- 一个本地 OpenAI 兼容的推理后端（Ollama / LM Studio / vLLM /
  自建 router） —— 纯本地运行必需。
- macOS、Linux、Windows（Windows 推荐 WSL）。

---

## 常用命令

```bash
owlcoda                          # 默认进入 native 交互式 REPL
owlcoda -p "list all .ts files"  # 非交互模式 (headless one-shot)
owlcoda --resume last            # 恢复上次会话
owlcoda --model fast             # 按别名 / 部分 id 选择模型

owlcoda init                     # 创建 config.json（自动探测后端）
owlcoda doctor                   # 环境健康检查
owlcoda config                   # 查看当前配置 + 已解析模型
owlcoda models                   # 查看已配置模型 + runtime 可见性

owlcoda start | stop | status    # 后台 daemon 生命周期
owlcoda clients                  # 列出 / 解绑活跃 REPL 客户端
owlcoda ui --open-browser        # 启动 browser admin

owlcoda skills [list|show|synth|search|match|stats|export|import]
owlcoda training [status|scan|report|export jsonl|sharegpt|insights]
owlcoda audit | cache | logs | inspect | benchmark | health | validate
```

`owlcoda --help` 列出全部命令，按职能分组。

---

## 配置

`owlcoda init` 会写出一份合理默认的 `config.json`。手动编辑可参考
示例文件：

```bash
cp config.example.json config.json
```

最小 schema：

```json
{
  "port": 8019,
  "host": "127.0.0.1",
  "routerUrl": "http://127.0.0.1:11434/v1",
  "responseModelStyle": "platform",
  "models": [
    {
      "id": "qwen2.5-coder:7b",
      "label": "Qwen2.5 Coder 7B",
      "backendModel": "qwen2.5-coder:7b",
      "aliases": ["default", "fast"],
      "tier": "fast",
      "default": true
    }
  ],
  "trainingCollection": false
}
```

环境变量覆盖：

| 变量 | 作用 | 默认值 |
|---|---|---|
| `OWLCODA_PORT` | 监听端口 | `8019` |
| `OWLCODA_ROUTER_URL` | Router 地址 | `http://127.0.0.1:8009` |
| `OWLCODA_HOME` | 数据目录 | `~/.owlcoda` |
| `OWLCODA_LOG_LEVEL` | 日志级别 | `info` |
| `OWLCODA_TRAINING_COLLECTION` | `0` / `1`（覆盖 config） | 未设置 |

能力声明真值见 [`src/capabilities.ts`](src/capabilities.ts)
（该文件由 runtime 验证，反映"实际能跑"的能力清单）；完整配置
schema 见 [`config.example.json`](config.example.json)。

---

## Native REPL 亮点

- **42+ 工具** —— Bash、Read、Write、Edit、Glob、Grep、MCP 工具、
  agent dispatch、scheduling、plugin 等。
- **69+ slash 命令** —— `/model`、`/cost`、`/budget`、`/perf`、
  `/doctor`、`/config`、`/trace`、`/tokens`、`/sessions`、`/skills`、
  `/dashboard`、`/why-native`、…… `owlcoda --help` 与 `/help`
  会列出全部。
- **Selection-first transcript** —— 鼠标拖选与复制和其他终端 app
  完全一致。
- **会话持久化** —— 每次对话都自动落到 `~/.owlcoda/sessions/`，
  `--resume <id>` 可恢复任意一次。
- **技能学习 (L2)** —— 重复任务会被自动提取为可复用 skill，
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
        → 协议翻译 (Anthropic Messages ↔ OpenAI Chat Completions)
          → 你的本地 runtime (Ollama / LM Studio / vLLM / 自建)
              + 你自己配置的可选云端 provider
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
  本机的 `~/.owlcoda/` 下。不上传任何东西。
- 训练数据管线在 [`src/data/sanitize.ts`](src/data/sanitize.ts)
  做 PII 脱敏，所有记录在追加到 `~/.owlcoda/training/collected.jsonl`
  之前都会过这一层。
- OwlCoda 没有 telemetry 端点，也不会发起任何你没显式配置的
  外部请求。除你自己加的 provider 之外，配置里的 `routerUrl`
  是唯一的网络目标。

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
