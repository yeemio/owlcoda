# 安装 Dogfood 发现汇总（2026-06）

来自真实 **Windows** 安装与其它平台同样适用的结论。文档修复在本 PR；**npm 包**
行为改动见 [Issue #2](https://github.com/yeemio/owlcoda/issues/2)。

联系邮箱：**owlclaw@163.com**

## 总表

| # | 发现 | 用户体感 | 本 PR（文档） | 产品（npm） |
|---|------|----------|---------------|-------------|
| 1 | npm 镜像滞后于 registry.npmjs.org | 装到旧版 owlcoda | troubleshooting | doctor 对比 registry |
| 2 | 8019 孤儿 daemon、无 PID 文件 | 报 non-OwlCoda；stop 无效 | troubleshooting | healthz 识别并清理 |
| 3 | 新装 `models[]` 为空 | No usable model | install / troubleshooting | 首次引导文案 |
| 4 | `routerUrl` 带 `/v1` | 本地 runtime 不可达 | install / troubleshooting | 代码规范化 URL |
| 5 | 8B 以下 / 无 tools 模型进 REPL | 400 does not support tools | model-requirements | Admin/doctor 警告或拦截 |
| 6 | Agent 负载 vs `ollama run` | Ollama 快、OwlCoda 坏 | model-requirements | UI 预期说明 |
| 7 | **流式 30s headers 超时** | headers timeout 30000ms | troubleshooting | 本地/多 tool 放宽 |
| 8 | 默认 **模型 fallback** | 30s+30s 试更大模型 | troubleshooting | 单模型场景优化 |
| 9 | Admin 把 Ollama 配成 cloud `endpoint …/v1` | 路由混乱 | troubleshooting | 本地/云端表单区分 |
| 10 | 删源码目录 ≠ 卸载 | 残留 npm 与 ~/.owlcoda | troubleshooting | — |
| 11 | Ollama 未起时 init → 空 models | 静默空配置 | install | 探测或警告 |
| 12 | **Agent ≥8B** 产品边界 | 1.5B/4B 预期错误 | model-requirements | 配置时强制提示 |

## 30s headers 超时（#7）

审计日志常见 `headers timeout after 30000ms`，`durationMs` 约 60000（若开启 fallback）。

机制（0.14.52）：代理对流式上游有 **固定 30s** headers 阶段；REPL 每轮约 **47 个 tool**。
CPU 上 Ollama 首包可能 **35–40s+**，Ollama 仍正常，但超过 OwlCoda 30s 守卫。

缓解：≥8B + GPU；云端；单模型测试时 `"middleware": { "fallbackEnabled": false }`。

## Fallback 链（#8）

主模型 30s 超时后可能 fallback 到更大本地模型（audit：`fallbackUsed: true`），用户体感约 **60s** 才失败。

## Admin 误配（#9）

勿对标准 Ollama 同时使用 `routerUrl` 与 `endpoint: http://127.0.0.1:11434/v1` 的「云端式」条目。
本地应：`routerUrl` + `backendModel`，无多余 `endpoint`。

## 关联

- **PR #1** — 文档
- **Issue #2** — npm 产品改动

英文详表：[dogfood-findings.md](dogfood-findings.md)
