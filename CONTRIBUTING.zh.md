# 为 OwlCoda 贡献

[English](CONTRIBUTING.md) · [中文](CONTRIBUTING.zh.md)

感谢愿意花时间。OwlCoda 还是 Developer Preview，代码库迭代很快，
所以在你真正动手之前，请**先开 issue** 或直接联系维护者对一下方向。
这能避免双方都在已经被改写的功能上浪费时间。

## 开发环境搭建

```bash
git clone https://github.com/yeemio/owlcoda.git
cd owlcoda
npm install
npm run build
npm test
```

端到端测试需要一个本地 OpenAI 兼容的后端。最便宜的路径是
`ollama serve` + `ollama pull qwen2.5-coder:7b`；LM Studio 与
vLLM 也都可以。详见 README 的 Quickstart 段。

## 常用脚本

| 命令 | 作用 |
|---|---|
| `npm run build` | TypeScript 编译到 `dist/` |
| `npm run dev` | 通过 `tsx` 直接跑 `src/cli.ts`，不需 rebuild |
| `npm test` | Vitest 套件 —— ~3450 tests，~30s |
| `npm run smoke:fast` | Build + proxy 健康检查 |
| `npm run smoke` | 完整 smoke（会启动一个真实 backend） |

## 代码规范

- **TypeScript strict**，禁止隐式 `any`。`npm run build` 必须零错误。
- **测试就近**，与所测代码在同一区域，不要全局散落。新代码必带测试，
  bugfix 必带回归测试。
- **默认不写注释**。注释只解释 *why*，不解释 *what*。Commit message
  承担背景说明，标识符承担含义。
- **product 代码里不硬编码第三方 vendor 路径**。OwlCoda 定位独立平台 ——
  请不要重新引入针对竞品 vendored binary 的 probe。
- **隐私默认关闭**。任何新增的 collection / telemetry / 网络 egress
  必须 opt-in、有文档、可通过 env var 关闭。

## Commit / PR 风格

- 单一目的的 commit。多个小 commit 优于一个巨型 commit。
- 首行风格：`fix(area): 简短描述` 或 `feat(area): …`，与
  `git log --oneline` 已有惯例保持一致。
- PR 描述要说清*为什么*要做这个改动，不只是*改了什么*。UX 改动
  最好附 screenshot 或 asciinema。
- 提 PR 到 `main`。当前没有 release branch。

## 端到端测试

发起 review 之前：

1. `npm run build` —— 必须零错误。
2. `npm test` —— 必须通过（或在 PR 描述中解释失败原因）。
3. UX / TUI 相关改动：本地 `owlcoda` 跑一次真实后端，手动验证。
   类型检查与单元测试只能验证代码正确性，验证不了用户体验。
4. 在 `CHANGELOG.md` 当前 `## [0.1.x]` 段加一条简短 entry。

## 欢迎贡献的方向

- **TUI 打磨** —— scrollback watermark（见 `docs/ROADMAP.md`）、
  主题变体、可访问性模式。
- **Backend adapters** —— 在 `src/backends/` 下加更多本地
  OpenAI 兼容 backend 的支持。
- **Skills** —— 在 `skills/` 下加你日常工作流的领域 skill pack。
- **文档** —— screenshot、gif、具体使用场景的 walkthrough。

任何超过文档修复规模的改动：请先开 issue。

## 行为准则

请保持尊重。批评观点而非个人。默认假定善意。骚扰、人身攻击、
歧视性语言会被从 issue / PR / discussion 中移除。

私下举报行为问题：邮件维护者（见 `package.json` 的 `author`
字段）。
