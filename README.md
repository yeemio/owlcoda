# OwlCoda

> **Your models. Your tools. Your data. Runs locally — no login, no cloud.**
>
> OwlCoda is an independent, local-first AI coding workbench. Native REPL with
> 42+ tools, 69+ slash commands, session persistence, learned skills, and
> production-grade middleware — all on your own machine. Works with Ollama,
> LM Studio, vLLM, and any OpenAI-compatible local runtime.
>
> **Privacy by default**: sessions stay in `~/.owlcoda/`. Training-data
> collection is **opt-in** (off by default) and PII-sanitized before it ever
> touches disk. Nothing is uploaded.
>
> **Install** (npm package):
> `npm install -g owlcoda@latest`
>
> **First run**: `owlcoda` opens the normal setup path when no usable model is
> configured. You can also run `owlcoda admin` to configure your own local
> runtime endpoint or cloud provider.

---

**你的模型、你的工具、你的数据 —— 本地运行，不登录，不上云。**

OwlCoda 是一个独立的、本地优先的 AI 编码工作台（personal workbench）。
默认以 native REPL 运行，42+ 原生工具、69+ slash 命令、会话持久化、
技能学习与注入、生产级中间件，全部在你自己的机器上。

> **隐私默认值**：所有会话只落到本地 `~/.owlcoda/`。L3 训练数据收集
> **默认关闭**，开启需要显式 opt-in（`config.json` 或环境变量），
> 收集前会经 PII 脱敏，且只写本地磁盘 —— OwlCoda 不向任何远端上传。

> 产品真相以 [docs/PRODUCT-TRUTH.md](docs/PRODUCT-TRUTH.md) 为准；
> 运行时版本以 `owlcoda --version` 为准；能力声明真相在
> [`src/capabilities.ts`](src/capabilities.ts)，与下方能力矩阵一一对应。

## License And Distribution

OwlCoda is publicly installable through npm:

```bash
npm install -g owlcoda@latest
```

Starting with the `0.15.0` license boundary, OwlCoda source is released under
`GPL-3.0-or-later`. Commercial, OEM, or embedded distribution uses a separate
license path handled by the maintainer.

The public GitHub repository is the public source, issue, release, and trust
surface for published GPL releases:

https://github.com/yeemio/owlcoda

For npm packages that ship compiled `dist/`, see [SOURCE.md](SOURCE.md) for
the corresponding-source requirement. Historical published versions remain
under the license terms that accompanied those versions when they were
published.

Fresh installs do not include maintainer model configuration. Configure your
own local runtime endpoint or cloud provider in Admin:

```bash
owlcoda
owlcoda admin
```

中文口径：从 `0.15.0` 许可证边界开始，OwlCoda 源码按
`GPL-3.0-or-later` 公开；商业、OEM、嵌入式分发走维护者单独授权。
公仓承担公开源码、issues、release 和信任入口；npm 包若只携带编译产物，
必须按 [SOURCE.md](SOURCE.md) 指向对应版本源码。

## Known Limitations

Global install policy:

- The global `owlcoda` command should be the latest npm release.
- Local development builds should not be linked globally by default.
- To test a local build, run `node dist/cli.js` from the repo, or use a
  temporary npm prefix.
- To check what you are running:

```bash
which owlcoda
npm ls -g owlcoda --depth=0
owlcoda --version
```

发布前请先看一眼这些已知限制，避免踩坑：

- **终端原生滚轮回看 transcript 暂未生效**：mouse-wheel / tmux copy-mode
  当前看不到完整历史。app 内可用 `PgUp` / `PgDn` / `Ctrl+↓` 或 `/history`
  回看。该 P0 已定位（Ink fork 的 watermark 路线），上一次实验性实现因
  side-channel stdout 与 commit-phase paint 抢占被回退，本版本暂不携带
  修复，下一个 patch 会走 `log.render` 返回水位 ANSI 的稳定方案。
- **`/cost` 美元金额只是参考**：本地推理实际成本接近零，显示用的是云端定价
  做横向对比，不是你的真实电费。
- **LSP 工具默认不绑 language server**：需要手动安装并通过 plugin
  注入 `lspServers` 配置，详见 LSP 使用指南章节。
- **OAuth 类远程 MCP server 暂不支持**，stdio MCP server 完整可用。

## Why OwlCoda

- **本地模型治理**：不是单一 provider 客户端，而是本地模型平台的统一前门
- **自有产品路线**：OwlCoda 走自己的 native 前端和工具链路线，不再把外部产品当运行前门
- **越用越强**：L2 技能学习已经上线，重复任务会沉淀为可复用操作知识
- **数据归自己**：L3 数据管线把使用过程沉淀为可审查、可导出的本地数据资产
- **生产级中间件**：fallback、retry、health、audit、metrics、cost、routing 都是产品本体的一部分
- **产品边界清晰**：OwlCoda 只依赖自己的 native 路线和本地/云端模型，不依赖其他编码助手产品

## 架构

```
owlcoda CLI (cli-core.ts)
  → startNativeRepl() — OwlCoda 自有 REPL（默认）
    → 42+ native tools + 69+ commands
      → OwlCoda proxy → endpoint（云厂 / 本地 runtime / 自建 OpenAI-Anthropic compatible）→ 模型
```

| 层 | 源码 | 职责 |
|---|---|---|
| CLI 入口 | `src/cli.ts` → `src/cli-core.ts` | 参数解析、proxy daemon、配置加载 |
| 协议翻译 | `src/translate/` | Messages API ↔ OpenAI Chat Completions |
| Proxy HTTP | `src/server.ts` | HTTP 服务、路由、SSE 流 |
| 模型配置 | `src/config.ts` | catalog.json 驱动的模型 registry |

## 快速开始

> **当前形态**：npm 公开发行包 + GPL 公开源码。`0.15.0` 起，
> GPL 发行版本必须在公仓提供匹配源码 tag；维护者私仓仍可作为日常开发
> 工作区，但不能替代公开发行版本的对应源码。

### 前置条件

- Node.js >= 20.19.0. Node 22+ is recommended.
- 本地 LLM 推理后端（Ollama / LM Studio / vLLM / 自建 OpenAI-compatible endpoint）任选其一

### 安装与首跑（npm）

OwlCoda 只提供一条正式产品路径：native 模式。42+ 原生工具，69+ 命令，会话持久化。

```bash
# 1. 安装公开发行包
npm install -g owlcoda@latest

# 2. 启动；如果还没有可用模型，会进入 Admin 配置路径
owlcoda

# 3. 手动打开 Admin 也可以
owlcoda admin
```

如果全局 npm prefix 没有写权限，优先使用用户级 prefix：

```bash
npm config set prefix ~/.local
export PATH=~/.local/bin:$PATH
npm install -g owlcoda@latest
```

开发者在私仓测试本地构建时，不要把 WIP 版本长期 `npm link` 成全局命令：

```bash
npm run build
node dist/cli.js --version
node dist/cli.js
```

### 30 秒跑通：以 Ollama 为例

Windows 兼容说明：试运行期支持路径是 npm 安装包，不需要开启 Developer Mode
或修改 Git symlink 设置。

零知识用户最短路径——假设你**完全没有任何模型/endpoint**：

```bash
# a. 装 Ollama 并拉一个编码模型
brew install ollama && ollama serve &
ollama pull qwen2.5-coder:7b

# b. 让 OwlCoda 直接对接 Ollama（OpenAI 兼容 endpoint :11434/v1）
owlcoda init --endpoint http://127.0.0.1:11434/v1

# c. 启动
owlcoda
```

LM Studio 用户把 `--endpoint` 改成 `http://127.0.0.1:1234/v1`；vLLM 用户改成 `http://127.0.0.1:8000/v1`。

MiMo/Xiaomi token-plan 用户在 Admin 里选 Xiaomi MiMo preset，或手工使用：

| 协议 | Endpoint | Model id |
| --- | --- | --- |
| Anthropic-compatible | `https://token-plan-sgp.xiaomimimo.com/anthropic` | `mimo-v2.5-pro` |
| OpenAI-compatible | `https://token-plan-sgp.xiaomimimo.com/v1` | `mimo-v2.5-pro` |

MiMo model id 必须小写。`MiMo-V2.5-Pro` 这种展示名会被 provider 拒绝。

### 配置

`owlcoda init` 会写出 `config.json`。如果想手工编辑，可参考 `config.example.json`：

```bash
cp config.example.json config.json
# 编辑 config.json，配置你的模型 ID、别名、后端地址
```

### 常用命令

```bash
owlcoda                         # 默认交互模式（native）
owlcoda --model fast            # 指定模型
owlcoda -p "list all .ts files" # 非交互模式（headless）
owlcoda init                    # 初始化 config.json（自动检测模型）
owlcoda doctor                  # 环境诊断（检查配置/endpoint/本地平台）
owlcoda config                  # 显示当前配置/模型/启动模式
owlcoda models                  # 分层模型列表 + 路由探测
owlcoda ui                      # 打印 browser admin one-shot URL
owlcoda ui --open-browser       # 显式打开 browser admin
owlcoda admin                   # browser admin 的别名
owlcoda validate                # 配置文件校验（schema + 语义）
owlcoda start                   # 仅启动后台代理
owlcoda status                  # 检查代理状态（含实时指标）
owlcoda stop                    # 停止后台代理
owlcoda serve                   # 仅启动 API 服务器
owlcoda logs                    # 尾随日志文件（JSON 格式化）
owlcoda benchmark               # 延迟基准测试（TTFT/总时/TPS）
owlcoda export                  # 导出脱敏配置（json/env/text）
owlcoda inspect                 # 查看最近请求/响应交换
owlcoda health                  # 代理/endpoint/模型健康诊断
owlcoda audit                   # 查询请求审计日志
owlcoda cache                   # 查看/清除响应缓存统计
owlcoda completions <shell>     # 生成 shell 自动补全（bash/zsh/fish）
owlcoda --resume last           # 恢复上次会话
owlcoda --dry-run               # 4步预检（config→validate→ports→doctor）
owlcoda skills                  # 列出已学习的技能（= skills list）
owlcoda skills info             # 技能库概览（curated/learned 计数 + 顶部 tags）
owlcoda skills list             # 列出已学习技能（--json 可导出）
owlcoda skills show <id>        # 查看技能详情
owlcoda skills synth <session>  # 从会话合成技能
owlcoda skills delete <id>      # 删除技能
owlcoda skills search <keyword> # 按关键词搜索技能
owlcoda skills match <query>    # TF-IDF 语义匹配技能
owlcoda skills stats            # 技能库健康报告
owlcoda skills cleanup          # 清理过期和未使用的技能
owlcoda skills export           # 导出技能为 JSON
owlcoda skills import <file>    # 从 JSON 文件导入技能
owlcoda sessions                # 查看最近会话（--limit N, --tag T, --json）
owlcoda training status                  # 收集数据集状态（manifest + collected.jsonl）
owlcoda training path                    # 打印 collected.jsonl 文件路径
owlcoda training report                  # 收集数据集汇总（默认）
owlcoda training report --from-sessions  # 历史会话的质量分布分析
owlcoda training export jsonl [--limit N] [--sanitize]
                                         # 流式输出 collected.jsonl 行（默认）
owlcoda training export [jsonl|sharegpt|insights] --from-sessions [--min-quality N] [--min-complexity N] [--tool-calls-only] [--sanitize] [--limit N]
                                         # 从历史会话生成各种格式
owlcoda training scan                    # 批量扫描历史会话，把合格的写入 collected.jsonl
owlcoda training clear                   # 清除已收集的训练数据
```

## Browser Admin And Diagnostics

- `owlcoda ui` / `owlcoda admin` 会复用本地 server，生成 one-shot `/admin/` URL；默认只打印 URL，不自动打开浏览器
- `owlcoda ui --open-browser` 才会显式调用本机浏览器
- `owlcoda ui --print-url` 继续保留，行为上等同于默认的只打印 URL
- `/models edit <id>` 和 `/models browser [route] [id]` 可以从 TUI 直接 handoff 到 browser admin
- provider failure diagnostics 已统一到主 agent、subagent、`/v1/messages`、`/v1/chat/completions`、admin `test connection` 和 `/warmup`

操作路径、边界和 operator 注意事项见：
[docs/admin-browser-operator.md](docs/admin-browser-operator.md)

## L2: 技能学习（已上线）

OwlCoda 能从复杂会话中自动提取可复用技能，在未来类似任务时注入系统提示词。

### 工作流程

```
会话结束 → trace 分析 → 复杂度评估 → 技能合成 → 存储到 ~/.owlcoda/skills/
                                                         ↓
未来请求 → TF-IDF 匹配 → 匹配到的技能注入 system prompt → 模型获得经验
```

### 技能 API

| 端点 | 说明 |
|---|---|
| `GET /v1/skills` | 列出所有技能（元数据） |
| `GET /v1/skills/:id` | 获取完整技能文档 + Markdown |
| `POST /v1/skills` | 创建/更新技能 |
| `DELETE /v1/skills/:id` | 删除技能 |

### 自动注入

当 `/v1/messages` 收到请求时，OwlCoda 自动：
1. 用 TF-IDF 匹配用户消息与已有技能（72 个策展技能 + 用户学习技能）
2. 将匹配到的技能以 `<learned_skills>` 块注入 system prompt
3. 设置 `x-owlcoda-skills` 响应头标记注入了哪些技能
4. 设置 `x-owlcoda-skill-scores` 响应头附带匹配分数

### 配置

在 `config.json` 中可调整技能注入行为：

```json
{
  "skillInjection": true,
  "skillTopK": 2,
  "skillThreshold": 0.1
}
```

### 技能可观测性

| 端点 | 说明 |
|---|---|
| `GET /v1/skill-stats` | 注入统计（命中率、Top 10 技能、平均耗时） |
| `DELETE /v1/skill-stats` | 重置统计 |

`owlcoda status` 运行时也会显示技能注入统计。

### 与 Hermes 的区别

- **Hermes**: context-level 增强（记忆在窗口内，受上下文长度限制）
- **OwlCoda**: weight-level 增强方向（技能 → 训练数据 → 模型微调 → 更好的模型）

## L3: 训练数据管线（已上线，**默认关闭**）

OwlCoda 可以从会话中收集、评分、导出训练数据，为本地模型微调提供数据飞轮。

> **隐私默认值**：训练数据收集 **opt-in**，默认关闭。开启前不会有任何会话被写入磁盘的训练目录。
>
> **开启方式**（任选其一）：
> - 编辑 `config.json` 把 `"trainingCollection": false` 改成 `true`
> - 临时启用：`OWLCODA_TRAINING_COLLECTION=1 owlcoda`
> - 临时关闭：`OWLCODA_TRAINING_COLLECTION=0 owlcoda`（环境变量优先于 config）
>
> 收集的数据**仅写到本地** `~/.owlcoda/training/collected.jsonl`，落盘前已经过 `src/data/sanitize.ts` 的 PII 脱敏。OwlCoda 不会向任何远端上传训练数据。

### 工作流程

```
会话结束 → 质量评分（5维度加权） → 阈值过滤 → PII 脱敏 → JSONL 存储
                                                              ↓
owlcoda training scan                — 批量扫描历史会话，把合格的追加到 collected.jsonl
owlcoda training report              — 默认报告 collected.jsonl 状态；--from-sessions 切到质量分布分析
owlcoda training export jsonl        — 流式输出 collected.jsonl（支持 --limit / --sanitize）
owlcoda training export ... --from-sessions — 从历史会话再次生成 JSONL/ShareGPT/insights
```

### 质量评分维度

| 维度 | 权重 | 说明 |
|---|---|---|
| coherence | 25% | 对话连贯性和上下文一致性 |
| informativeness | 25% | 信息密度，是否有实质内容 |
| toolRichness | 20% | 工具调用丰富度（代码、文件、搜索） |
| completeness | 15% | 任务完成度 |
| complexity | 15% | 多步推理和复杂度 |

默认阈值：质量 ≥ 60 / 消息数 ≥ 4。

## 能力矩阵

> 基于当前运行时验证。标签含义：
> - **supported** — 端到端验证通过
> - **partial** — 可用但有已知限制
> - **best_effort** — 协议支持，但完全取决于后端能力
> - **manual-only** — 需用户手动配置/安装外部依赖
> - **blocked** / **unsupported** — 当前不可用（代码层面被 stub 或未实现）

| 能力 | 状态 | 说明 |
|---|---|---|
| Headless (`-p`) | **supported** | 端到端通过，含工具调用 |
| TUI 交互 | **supported** | 单轮/多轮对话、上下文保持 |
| `/model` 切换 | **supported** | Picker 显示 OwlCoda 模型；切换后后续请求使用新模型 |
| `/cost` 显示 | **partial** | Token 计数与时长真实；USD 用 Anthropic 云端定价做横向参考，本地推理实际成本接近零 |
| Wheel/trackpad transcript 滚动 | **partial** | Terminal.app 直连场景已验证；tmux 等 multiplexer 下 wheel 透传不保证，请用 PgUp/PgDn 或 Ctrl+↓；iTerm2 验证待补 |
| `/doctor` 诊断 | **supported** | 平台健康检查：Router、Backend、MCP、Proxy 状态 |
| `/config` 配置查看 | **supported** | 显示运行时配置：模型、代理、路由、功能开关 |
| `/trace` 调试日志 | **supported** | OWLCODA_TRACE=1 或 /trace 开关，请求/响应写入 ~/.owlcoda/trace/ |
| `/tokens` 用量 | **supported** | 累计 token 计数：输入/输出/总量/请求数 |
| `/budget` 上下文预算 | **supported** | 已用 vs 上下文窗口，含百分比和剩余估计 |
| `/perf` 性能 | **supported** | 每模型实时 TPS、延迟（avg/p50）、成功率 |
| `/warmup` 预热 | **supported** | 手动预热模型（发送小请求加载权重） |
| `/recommend` 推荐 | **supported** | 意图导向模型推荐（code/analysis/chat/search） |
| BashTool + 25 工具 | **supported** | 通过 native 工具运行时 |
| Skill 系统 | **supported** | SkillTool 可发现并注入 SKILL.md |
| L2 技能学习 | **supported** | 会话 trace 分析 → TF-IDF 匹配 → 自动注入 system prompt |
| 技能 CLI | **supported** | `owlcoda skills` — list/show/synth/delete |
| 自动合成 | **supported** | 复杂会话结束后自动提取技能 |
| L3 数据管线 | **supported** | 质量评分 → 自动收集 → PII 脱敏 → JSONL 训练数据（写到 ~/.owlcoda/training/collected.jsonl） |
| 训练数据导出 (jsonl) | **supported** | `owlcoda training export jsonl [--limit N] [--sanitize]` 流式读取 collected.jsonl |
| 训练数据导出 (sharegpt/insights) | **supported via --from-sessions** | 仅 `owlcoda training export <fmt> --from-sessions` 从历史会话再生成；collected.jsonl 本身只存 jsonl 形态 |
| 训练数据状态/路径/清理 | **supported** | `owlcoda training status / path / clear / scan` + `/v1/training/status` + `/v1/training/export` (NDJSON 流) |
| 训练数据报告 | **supported** | `owlcoda training report` 默认基于 collected dataset；`--from-sessions` 切到历史质量分布 |
| Native REPL `/training` | **supported** | `/training [status|path|sample|export]` 只读，不会 dump 全部数据集 |
| Admin Training 页面 | **deferred** | 见 docs/follow-ups/admin-training-page-2026-04-26.md（CLI + REPL 已覆盖） |
| LSP 工具 | **manual-only** | 需 plugin 提供 lspServers 配置（见下方指南） |
| MCP 服务器 | **supported** | `.mcp.json` 配置 stdio MCP server |
| Feature Flags | **supported** | 白名单架构：MCP_RICH_OUTPUT, SLOW_OPERATION_LOGGING |
| 文本流式/非流式 | **supported** | 完整 messages SSE 翻译 |
| Tool use 协议 | **supported** | tool_use ↔ OpenAI function_calling 双向翻译 |
| 会话持久化 | **supported** | 自动保存到 `~/.owlcoda/sessions/` |
| 会话搜索/标签/分支 | **supported** | `/sessions`, `/tag`, `/branch`, `/history` |
| 插件系统 | **supported** | hooks (onRequest, onResponse, onError)，`~/.owlcoda/plugins/` |
| 配置热更新 | **supported** | 修改 config.json 自动检测、验证、应用 |
| 多后端发现 | **supported** | Ollama (11434)、LM Studio (1234)、vLLM (8000) 自动探测 |
| 意图路由 | **supported** | 根据工具/提示/消息检测意图，路由到最优模型 |
| 跨后端 fallback | **supported** | 不同后端模型优先尝试，提升容灾能力 |
| 模型 warmup | **supported** | 启动时自动预热发现的模型 |
| 模型推荐 | **supported** | 基于意图+性能+成本的评分引擎 |
| 模型 fallback | **supported** | 自动降级到备选模型（5xx/超时） |
| 熔断器 | **supported** | 连续 5 次失败自动禁用，60s 冷却 |
| 请求重试 | **supported** | 指数退避重试（5xx/超时），可配置 |
| 限流 | **supported** | 每模型 token bucket，默认 60 RPM |
| OpenAPI spec | **supported** | `GET /openapi.json`，自动反映所有端点 |
| Prometheus 指标 | **supported** | `GET /metrics`，标准 Prometheus 格式 |
| 审计日志 | **supported** | 持久化 JSONL，`~/.owlcoda/audit.jsonl` |
| 请求审计 API | **supported** | 500 条环形缓冲，CLI `owlcoda audit` + `GET /v1/audit` |
| 响应缓存 | **supported** | LRU 100 条 + 5 分钟 TTL，命中时跳过上游调用 |
| 延迟直方图 | **supported** | 每端点 p50/p90/p95/p99，`GET /v1/latency` |
| 配置自动迁移 | **supported** | 4 步迁移链，加载时自动升级旧配置 |
| 每模型超时 | **supported** | `timeoutMs` 覆盖全局 `routerTimeoutMs` |
| 语义配置校验 | **supported** | 7 项智能检查（重复别名、端口冲突等） |
| 平台模型 registry | **supported** | config.json 驱动，多模型 + 别名 |

### `/cost` 成本估算

`/cost` 命令现在展示真实的本地成本估算：

- **多模型分解**：每个模型独立计算 input/output 成本
- **真实 TPS**：使用性能追踪器的实际 tokens/s 数据
- **本地定价**：基于模型参数量的估算（以 ¥ 为单位，反映电力成本）
- **HTTP API**：`GET /v1/cost` 返回 JSON 格式的成本数据

### HTTP API

| 端点 | 说明 |
|---|---|
| `POST /v1/messages` | Messages API（流式 + 非流式，含响应缓存） |
| `POST /v1/chat/completions` | OpenAI 兼容透传端点 |
| `GET /v1/models` | 可用模型列表 |
| `GET /v1/backends` | 后端自动发现（Ollama/LM Studio/vLLM） |
| `GET /v1/perf` | 每模型性能指标（延迟、TPS、成功率） |
| `GET /v1/latency` | 延迟百分位（p50/p90/p95/p99）按端点分组 |
| `GET /v1/cost` | 会话成本摘要（按模型分解） |
| `GET /v1/recommend?intent=code` | 模型推荐（意图导向评分） |
| `GET /v1/usage` | Token 用量统计 |
| `GET /v1/audit` | 请求审计日志（过滤：model/status/duration） |
| `GET /v1/cache` | 响应缓存统计（命中率、大小、TTL） |
| `DELETE /v1/cache` | 清除所有缓存条目 |
| `GET /v1/skills` | 已学习技能列表 |
| `GET /v1/skills/:id` | 技能详情 + Markdown |
| `POST /v1/skills` | 创建/更新技能 |
| `DELETE /v1/skills/:id` | 删除技能 |
| `GET /v1/insights/:sessionId` | 会话分析（复杂度 + 质量 + 技能匹配） |
| `GET /v1/training/status` | 训练数据收集统计 |
| `POST /v1/training/clear` | 清除已收集训练数据 |
| `GET /v1/training/export` | 下载已收集 JSONL 训练数据 |
| `GET /v1/captures` | 最近 50 条请求/响应记录 |
| `POST /v1/search` | 本地搜索（SearXNG） |
| `GET /openapi.json` | OpenAPI 3.0 规范（自动反映所有端点） |
| `GET /metrics` | Prometheus 指标 |
| `GET /health` | 健康检查 |

### LSP 使用指南

OwlCoda 已开启 LSP 工具（`ENABLE_LSP_TOOL=1`），但需要用户安装对应的 language server：

```bash
# TypeScript/JavaScript
npm install -g typescript-language-server typescript

# Python
pip install pyright
# 或
pip install python-lsp-server

# Rust
rustup component add rust-analyzer

# Go
go install golang.org/x/tools/gopls@latest
```

安装后，在 TUI 中可使用 go-to-definition、find-references、hover 等 LSP 功能。

### MCP 配置指南

OwlCoda 的 MCP（Model Context Protocol）支持已在 Round 3 **完全解锁**。MCP client 已从 stub 替换为真实实现，stdio 类型的 MCP server 可以正常连接和使用。

**配置方法**：在项目根目录创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "mcp-server-filesystem",
      "args": ["/path/to/allowed/directory"]
    }
  }
}
```

**验证**：启动 OwlCoda 后，MCP 工具会自动注册并出现在可用工具列表中（如 `mcp__filesystem__read_file`）。

**注意**：
- 项目级 `.mcp.json` 在 `-p` 模式下自动信任
- TUI 模式下首次使用可能需要确认
- OAuth 类远程 MCP server 暂不支持

## 配置

默认配置文件：`config.json`（项目目录）或 `~/.owlcoda/config.json`

### 零配置（推荐）

如果平台 `catalog.json` 可达，OwlCoda 自动从 catalog 加载所有模型——无需手动配置 models 数组。

### 手动配置（可选覆盖）

```json
{
  "port": 8019,
  "responseModelStyle": "platform",
  "models": [
    {
      "id": "qwen2.5-coder:32b",
      "label": "Qwen2.5 Coder 32B",
      "backendModel": "qwen2.5-coder:32b",
      "endpoint": "http://127.0.0.1:11434/v1",
      "aliases": ["balanced", "default"],
      "tier": "balanced",
      "default": true
    },
    {
      "id": "qwen2.5-coder:7b",
      "label": "Qwen2.5 Coder 7B",
      "backendModel": "qwen2.5-coder:7b",
      "endpoint": "http://127.0.0.1:11434/v1",
      "aliases": ["fast"],
      "tier": "fast"
    }
  ]
}
```

### 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `OWLCODA_PORT` | 监听端口 | 8019 |
| `OWLCODA_LOG_LEVEL` | 日志级别 | info |
| `OWLCODA_HOME` | 数据目录 | ~/.owlcoda |
| `OWLCODA_RENDER_MODE` | 画屏方式：`safe`=稳（每行重画，默认），`diff`=省字节但在 tmux/screen 等多路复用终端里会糊屏 | safe |
| `OWLCODA_FORCE_UNSAFE_DIFF` | 在 tmux/screen/zellij 里强行用 `diff`（平时会被自动夹回 safe）。只为复现糊屏，日常别开 | 关 |
| `OWLCODA_AMBIGUOUS_WIDTH` | 歧义宽字符（`→ ≤ ● │` 等）按窄(`narrow`/`1`)还是宽(`wide`/`2`)算。表格/边框对不齐时设 `wide`。不设则自动探测，探测不到时按终端语言（中日韩→宽）兜底 | 自动 |
| `OWLCODA_DEBUG` | 设 `1` 把终端探测/渲染决策写进 `~/.owlcoda/debug.log`（也可用 `OWLCODA_DEBUG_LOG=/path` 指定文件）。排查糊屏/对齐时开 | 关 |
| `OWLCODA_CLOUD_HEADERS_TIMEOUT_MS` | 云端模型「等响应头」的超时（毫秒）。默认 30s 是为了快速发现卡住的连接；但慢的云端推理模型（如 kimi-code/mimo，非流式整段算完才回头）可能要 30–210s 才出第一个字节，会被 30s 误判→提前切换 fallback 模型。跑已知慢的云模型时调大（如 `180000`）。只影响云端，本地 loopback 不受影响 | 30000 |

### CLI 用法

```
owlcoda [options]

Options:
  -p, --prompt <text>    非交互模式：发送 prompt 后退出
  -m, --model <name>     选择模型（平台 ID、别名或部分匹配）
  --resume <id|last>     恢复历史会话（必填参数；用 'last' 恢复上次）
  --json                 JSON 输出
  --auto-approve         自动批准工具执行
  --daemon-only          仅确保后台代理运行
  -h, --help             显示帮助
  -v, --version          显示版本
```

## 开发

```bash
npm run dev       # 开发模式（tsx 热加载）
npm test          # 运行测试
npm run build     # TypeScript 编译
```

## 源码结构

```
src/
├── cli.ts                 # ESM 入口
├── cli-core.ts            # CLI 逻辑 + 参数解析
├── daemon.ts              # daemon 进程生命周期
├── server.ts              # HTTP server + 路由
├── config.ts              # 配置加载 + 模型 registry
├── model-registry.ts      # 模型解析、路由、可用性
├── config-validate.ts     # 配置校验
├── config-watcher.ts      # 配置热更新
├── capabilities.ts        # 能力声明矩阵（honest labels）
├── runtime-profile.ts     # 独立运行 profile 管理
├── preflight.ts           # 平台预检
├── openapi.ts             # OpenAPI 3.0 spec
├── prometheus.ts          # Prometheus 指标导出
├── audit.ts               # 审计日志
├── trace.ts               # Token 使用追踪
├── request-trace.ts       # 请求时序瀑布
├── error-budget.ts        # SLO / 错误预算
├── health-monitor.ts      # 后台健康探测
├── logger.ts              # 结构化日志
├── log-file.ts            # 日志文件轮转
├── translate/
│   ├── request.ts         # Messages API → OpenAI 请求翻译
│   ├── stream.ts          # SSE 流式翻译状态机
│   ├── response.ts        # 非流式响应翻译
│   └── tools.ts           # Tool schema 翻译
├── endpoints/             # HTTP 路由处理 (messages, models, stubs, count-tokens, skills)
├── routes/                # 路由模块 (admin, search)
├── middleware/             # 请求管道 (retry, rate-limit, fallback, circuit-breaker, validate)
├── plugins/               # 插件系统 (loader, hooks, types)
├── skills/                # L2 技能学习 (schema, store, matcher, synthesizer, injection, auto-synth)
├── data/                  # L3 数据管线 (quality, export, collector, sanitize)
├── native/                # 自有前端主线 (REPL, headless, TUI, tools, protocol)
├── frontend/              # TUI 命令 + 显示 (commands, display, repl)
├── history/               # 会话持久化 (sessions, catalog)
├── utils/                 # 工具函数 (errors, sse, ratelimit, logger)
└── models/                # catalog 适配器
```
