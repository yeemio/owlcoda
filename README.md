# OwlCoda

[Website](https://owlcoda.com) · [Install](docs/install.md) · [Changelog](CHANGELOG.md) · [Issues](https://github.com/yeemio/owlcoda/issues) · [中文](README.zh.md)

> **Your models. Your tools. On your machine.**

OwlCoda is a local-first AI coding workbench: a native terminal agent,
a browser Admin, and a model router you control. It connects to your own
local runtime or cloud API key. There is no OwlCoda account, no hosted
control plane, and no telemetry pipeline.

**Current public package:** `owlcoda@0.14.14`

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

It is **not** the current product source tree. During the trial phase,
the public distribution channel is the npm package.

## Source Release Gate

OwlCoda is available today as an npm package. Full source publication
will be revisited when the project has enough real community scale to
make open source protective instead of extractive. The current reference
threshold is roughly **1000+ real users** or equivalent external adoption
and support capacity.

The technical gate is also still deliberate: the broader Owl stack should
prove the local learning loop first, from local training-data accumulation
to learning/adaptation, runtime-truth registration, and OwlCoda consuming
that truth again.

This is not a "closed forever" position. It is the current trial-release
posture.

## Install

Prerequisites:

- Node.js `>= 20.19.0`; Node 22+ recommended
- macOS, Linux, or Windows
- a local OpenAI-compatible runtime or a cloud provider API key

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

See [docs/install.md](docs/install.md) for platform notes.

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
bug reports and feature requests. Pull requests are not accepted during
the npm-only trial because the implementation source of truth is not this
repository.

For security issues, do not file a public issue. See [SECURITY.md](SECURITY.md).

