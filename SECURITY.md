# Security Policy

[English](SECURITY.md) · [中文](SECURITY.zh.md)

## Supported Versions

OwlCoda is pre-1.0 (current stream: `0.1.x`). Only the latest minor
tag on `main` receives security fixes. If you run an older build,
upgrade first.

| Version | Supported |
|---------|-----------|
| `0.1.x` | ✅ |
| `< 0.1` | ❌ |

## Reporting a Vulnerability

Please **do not file a public GitHub issue** for security vulnerabilities.

Instead, email **yeemio@gmail.com** with:

- a clear description of the issue and its impact
- reproduction steps or a minimal proof-of-concept
- the affected version (`owlcoda --version`)
- your preferred disclosure timeline (if any)

You should receive an acknowledgement within **72 hours**. We aim to
either ship a fix or publish a public advisory within **90 days** of
the initial report, whichever comes first.

## Scope

OwlCoda is a local-first tool. The primary trust boundaries are:

- **localhost HTTP surface** — proxy and admin endpoints bind to
  `127.0.0.1` by default. Bearer-gated admin routes + session cookie.
- **Tool sandbox** — Bash/Read/Write/Edit/Glob/Grep tools respect a
  workspace boundary and permission prompts for destructive actions.
- **Config file** — `config.json` may contain API keys for cloud
  endpoints; it is read locally and never transmitted.
- **Session data** — persisted to `~/.owlcoda/sessions/`. Training data
  collection is **opt-in** and PII-sanitized before landing on disk.

We welcome reports on any of the above, as well as:

- supply-chain risks (e.g. typosquatting, dependency CVEs)
- AuthN/AuthZ bypasses in the admin API
- command injection via tool arguments
- path traversal outside the workspace boundary

## Out of Scope

- Running OwlCoda with `--auto-approve` and then having a tool do
  destructive things. That flag explicitly opts out of the safety prompt.
- Vulnerabilities in third-party local inference backends (report those
  to Ollama / LM Studio / vLLM upstream).
- Physical access to an unlocked developer machine.
