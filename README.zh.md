# OwlCoda

[官网](https://owlcoda.com) · [安装](docs/install.md) · [更新日志](CHANGELOG.md) · [Issues](https://github.com/yeemio/owlcoda/issues) · [English](README.md)

> **你的模型。你的工具。在你自己的机器上。**

OwlCoda 是一个本地优先的 AI 编码工作台：native 终端 agent、浏览器
Admin，以及由你掌控的模型路由。它连接你自己的本地 runtime 或云端
API key。没有 OwlCoda 账号，没有托管控制面，也没有 telemetry 管线。

**当前公开 npm 包：** `owlcoda@0.14.14`

```bash
npm install -g owlcoda
owlcoda
```

## 这个仓库是什么

这个仓库是 OwlCoda 的公开路由器：

- 安装和升级说明
- 公开 changelog
- issue 和需求反馈入口
- 安全联系入口
- 官网和信任表面链接

它**不是**当前产品源码树。试运行阶段，公开发行渠道是 npm 包。

## 源码发布 Gate

OwlCoda 今天已经可以通过 npm 使用。完整源码发布会等项目具备足够真实
社区规模后再重新评估，让开源变成保护，而不是单向暴露。当前参考门槛是
大约 **1000+ 真实用户**，或等价的外部采用和支持能力。

技术 gate 也仍然保留：更大的 Owl stack 需要先证明本地学习闭环，也就是
从本地训练数据积累，到学习/适配，到 runtime truth 回注册，再到 OwlCoda
重新消费这份 truth。

这不是“永远闭源”的口径，而是当前试运行发布姿态。

## 安装

前置条件：

- Node.js `>= 20.19.0`，推荐 Node 22+
- macOS、Linux 或 Windows
- 一个本地 OpenAI-compatible runtime，或一个云端 provider API key

```bash
npm install -g owlcoda
owlcoda --version
owlcoda doctor
owlcoda
```

fresh install 不会默认带维护者模型配置。首次运行时，打开 Admin，配置你
自己的本地 runtime 或云端 provider：

```bash
owlcoda admin
```

平台说明见 [docs/install.md](docs/install.md)。

## 升级

```bash
npm update -g owlcoda
npm ls -g owlcoda --depth=0
owlcoda --version
```

如果升级后旧的 `localhost` Admin 页面仍显示早期版本，先关掉旧 OwlCoda
进程，再重新运行 `owlcoda`。旧 daemon 可能会继续服务旧 Admin bundle，
直到它被重启。

## 反馈

公开 bug 和需求请走 [GitHub Issues](https://github.com/yeemio/owlcoda/issues)。
试运行阶段不接受 Pull Request，因为实现源码真源不在这个仓库。

安全问题不要提交公开 issue。请看 [SECURITY.md](SECURITY.md)。

