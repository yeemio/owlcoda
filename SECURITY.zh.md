# 安全策略

[English](SECURITY.md) · [中文](SECURITY.zh.md)

## 支持版本

OwlCoda 当前仍是 pre-1.0。只有最新 npm 发行版接收安全修复。

| 版本 | 是否支持 |
| --- | --- |
| 最新 npm 发行版 | 是 |
| 更早版本 | 请先升级 |

检查当前安装版本：

```bash
owlcoda --version
npm view owlcoda version
```

## 报告漏洞

请不要在公开 GitHub issue 里提交安全漏洞。

请邮件发送到 **yeemio@gmail.com**，尽量包含：

- 漏洞描述和影响
- 复现步骤或最小 PoC
- `owlcoda --version` 输出的受影响版本
- 你期望的披露时间线，如有

通常会在 72 小时内确认收到。

## 范围

OwlCoda 是本地优先工具。尤其欢迎以下方向的报告：

- localhost Admin/API 授权
- 命令/工具执行安全
- workspace 边界处理
- config 和 API key 处理
- `~/.owlcoda/` 下的 session 数据处理
- npm package 供应链风险

## 范围之外

- 第三方本地推理 runtime 自身漏洞。
- 对未锁屏开发机的物理访问。
- 用户明确批准或关闭安全提示后的破坏性命令执行。

