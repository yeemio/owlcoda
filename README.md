# OwlCoda

[Website](https://owlcoda.com) · [Install](docs/install.md) · [Changelog](CHANGELOG.md) · [Issues](https://github.com/yeemio/owlcoda/issues) · [中文](README.zh.md)

> **Your models. Your tools. On your machine.**

OwlCoda is a local-first AI coding workbench: a native terminal agent,
a browser Admin, and model routing you control. It connects to your own
local runtime endpoint or cloud API key. There is no OwlCoda account, no
hosted control plane, and no telemetry pipeline.

**Current public package:** `owlcoda@0.14.53`

```bash
npm install -g owlcoda
owlcoda
```

## What This Repository Is

This repository is the public router for OwlCoda:

- installation and upgrade instructions
- public changelog
- issue reports and feature requests
- security contact
- website and trust-surface links

It is **not** the current product source tree. The supported public
distribution channel is the npm package.

## Install

Prerequisites:

- Node.js `>= 20.19.0`; Node 22+ recommended
- macOS, Linux, or Windows
- a local OpenAI-compatible runtime or a cloud provider API key
- for native Agent / REPL: tool-capable models, typically **≥ 8B** locally — see
  [model requirements](docs/model-requirements.md)

```bash
npm install -g owlcoda
owlcoda --version
owlcoda doctor
owlcoda
```

Fresh installs do not include maintainer model configuration. On first
run, open Admin and configure your own local runtime or cloud provider:

```bash
owlcoda admin
```

For a local OpenAI-compatible runtime, you can also initialize the endpoint
directly:

```bash
owlcoda init --endpoint http://127.0.0.1:11434
```

See [docs/install.md](docs/install.md) for platform notes.

- [Model requirements](docs/model-requirements.md) (Agent vs chat; ≥ 8B local guidance)
- [Troubleshooting](docs/troubleshooting.md) (npm mirror, port 8019, first-run, small models)
- [Dogfood findings](docs/dogfood-findings.md) (full install/agent issue index)

## Upgrade

```bash
npm update -g owlcoda
npm ls -g owlcoda --depth=0
owlcoda --version
```

If an old `localhost` Admin page still shows an earlier version after an
upgrade, stop the old OwlCoda process and start `owlcoda` again. A stale
daemon can keep serving an old Admin bundle until it is restarted.

## Feedback

Use [GitHub Issues](https://github.com/yeemio/owlcoda/issues) for public
bug reports and feature requests. This public router accepts small
documentation corrections; product implementation pull requests are not
accepted here.

For security issues, do not file a public issue. See [SECURITY.md](SECURITY.md).
