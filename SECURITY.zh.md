# 安全策略

[English](SECURITY.md) · [中文](SECURITY.zh.md)

## 支持的版本

OwlCoda 当前 pre-1.0（现行 stream：`0.1.x`）。只有 `main` 上最新
的 minor tag 接收安全修复。如果你跑的是更老的构建，请先升级。

| 版本 | 是否支持 |
|---------|-----------|
| `0.1.x` | ✅ |
| `< 0.1` | ❌ |

## 报告漏洞

请**不要在公开的 GitHub issue 里**提交安全漏洞。

请改用邮件 **yeemio@gmail.com** 报告，请尽量包含：

- 漏洞的清晰描述与影响
- 复现步骤或最小化 PoC
- 受影响的版本（`owlcoda --version`）
- 你期望的披露时间线（如有）

你应当在 **72 小时内**收到确认。我们的目标是在初次报告后的
**90 天内**发布修复或公开 advisory，以先到者为准。

## 范围

OwlCoda 是个本地优先工具。主要的信任边界是：

- **本地 HTTP 表面** —— proxy 与 admin 端点默认绑定 `127.0.0.1`。
  admin 路由有 bearer token 与 session cookie 守卫。
- **工具沙箱** —— Bash / Read / Write / Edit / Glob / Grep 等工具
  尊重 workspace 边界，对破坏性操作有 permission prompt。
- **配置文件** —— `config.json` 可能含云端 endpoint 的 API key；
  本地读取，从不上传。
- **会话数据** —— 持久化到 `~/.owlcoda/sessions/`。训练数据
  收集是 **opt-in**，落盘前会经过 PII 脱敏。

以下方向同样欢迎报告：

- 供应链风险（如 typosquatting、依赖 CVE）
- admin API 的 AuthN / AuthZ 绕过
- 工具参数的 command injection
- workspace 边界外的 path traversal

## 范围之外

- 用户使用 `--auto-approve` 跑 OwlCoda 后被工具做了破坏性操作。
  那个 flag 是显式 opt-out 安全 prompt。
- 第三方本地推理后端的漏洞（请向 Ollama / LM Studio / vLLM
  上游报告）。
- 对未锁屏的开发机的物理访问。
