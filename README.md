# OwlCoda

**English** · [中文](README.zh.md)

> **Your models. Your tools. Your data. Runs locally — no login, no cloud.**

OwlCoda is an independent, local-first AI coding workbench: a native terminal
REPL with 42+ tools and 69+ slash commands, session persistence, learned
skills, and production-grade middleware — all on your own machine. **Every model
you use — a cloud brand or a model on your own hardware — is wired up and
governed from one place: the browser Admin.**

**Privacy by default.** Sessions stay in `~/.owlcoda/`. There is no OwlCoda
account and no OwlCoda server. Training-data collection is opt-in (off by
default), PII-sanitized before it touches disk, and never uploaded.

## One control plane for every model

`owlcoda admin` opens a browser console where you wire up any model and OwlCoda
routes to it. Cloud brands connect in one click — Kimi, DeepSeek, GPT, Claude,
Gemini, Grok, GLM, MiniMax — with the endpoint, default model, and aliases
filled in from a template; paste a key and you're live. Anything else — a model
on your own machine or any custom OpenAI-/Anthropic-compatible endpoint — goes
through the custom lane. Routing, fallback, health, cost, and audit all sit
behind the same console.

![Adding a model in OwlCoda Admin — cloud brands one-click, or custom / local endpoints](assets/branding/admin-models.png)

## Install

```bash
npm install -g owlcoda@latest
owlcoda            # first run opens setup when no model is configured
owlcoda admin      # browser admin: configure a local runtime or cloud provider
```

Requirements: Node.js `>=20.19.0` (Node 22+ recommended) and one LLM backend —
a local runtime (Ollama / LM Studio / vLLM / any OpenAI-compatible endpoint) or
a cloud provider's API key.

If your global npm prefix isn't writable, use a user-level prefix:

```bash
npm config set prefix ~/.local && export PATH=~/.local/bin:$PATH
npm install -g owlcoda@latest
```

## Quickstart — Ollama in 30 seconds

Starting from zero, with no model configured:

```bash
brew install ollama && ollama serve &
ollama pull qwen2.5-coder:7b
owlcoda init --endpoint http://127.0.0.1:11434/v1
owlcoda
```

LM Studio uses `http://127.0.0.1:1234/v1`; vLLM uses `http://127.0.0.1:8000/v1`.
Cloud providers are configured in `owlcoda admin`.

Don't start by asking it to rewrite a large project. In a repo you know, begin
read-only, then give it one small, clearly-scoped change:

```bash
cd your-project
owlcoda -p "Read this project and tell me the entry point, test command, and main directories. Do not modify files."
```

## What it is

OwlCoda sits between your models and your real project. The model can act, but
every action passes through a boundary, leaves an artifact, and is recorded — so
a long-running agent isn't trusted on its word alone.

- **Bring your own models.** Local runtimes and cloud providers collapse into
  one model registry with routing, fallback, retry, circuit-breaking, and
  per-model timeouts.
- **Native REPL.** 42+ tools (Bash, Read/Write/Edit, Glob, Grep, Task,
  MCP-served tools, agent dispatch) and 69+ slash commands, with session
  persistence, search, tags, and branching.
- **Learned skills.** Complex sessions are distilled into reusable skills and
  matched back into the system prompt on similar tasks. Manage them with
  `owlcoda skills`.
- **Training-data pipeline (opt-in).** Sessions can be scored, PII-sanitized,
  and exported to local JSONL for fine-tuning — off by default, local-only.
- **Browser admin & diagnostics.** `owlcoda admin` for model configuration;
  `owlcoda doctor` / `health` / `audit` / `inspect` for runtime diagnostics.

Capability labels (`supported` / `partial` / `manual-only` / `unsupported`) are
declared in [`src/capabilities.ts`](src/capabilities.ts) and kept honest against
runtime behavior.

## Common commands

```bash
owlcoda                          # interactive REPL (native)
owlcoda -m fast                  # pick a model by id / alias / partial match
owlcoda -p "list all .ts files"  # headless (non-interactive)
owlcoda init                     # write config.json (auto-detects models)
owlcoda admin                    # browser admin
owlcoda doctor                   # environment diagnostics
owlcoda models                   # tiered model list + route probing
owlcoda --resume last            # resume the previous session
owlcoda skills                   # list learned skills
owlcoda --help                   # full command list
```

## Configuration

`owlcoda init` writes `config.json`; see
[`config.example.json`](config.example.json) for the full shape. If a platform
`catalog.json` is reachable, models load automatically with no manual `models`
array.

```json
{
  "port": 8019,
  "models": [
    {
      "id": "qwen2.5-coder:32b",
      "backendModel": "qwen2.5-coder:32b",
      "endpoint": "http://127.0.0.1:11434/v1",
      "aliases": ["balanced", "default"],
      "default": true
    }
  ]
}
```

Selected environment variables:

| Variable | Purpose | Default |
|---|---|---|
| `OWLCODA_PORT` | Proxy listen port | `8019` |
| `OWLCODA_HOME` | Data directory | `~/.owlcoda` |
| `OWLCODA_LOG_LEVEL` | Log level | `info` |
| `OWLCODA_RENDER_MODE` | `safe` (per-line repaint, default) or `diff` | `safe` |

## Known limitations

- **Transcript scrollback** isn't wired to the mouse wheel yet under terminal
  multiplexers (tmux/screen). Use `PgUp` / `PgDn` / `Ctrl+↓` or `/history`
  inside the app.
- **`/cost` USD figures are a reference only** — local inference is effectively
  free; the dollar number uses cloud pricing for comparison.
- **LSP tools need a language server** you install yourself (e.g.
  `typescript-language-server`, `pyright`, `rust-analyzer`, `gopls`), wired via
  plugin config.
- **Remote OAuth MCP servers aren't supported** yet; stdio MCP servers (via
  `.mcp.json`) work.

## HTTP API

The proxy exposes an Anthropic-compatible `POST /v1/messages` and an
OpenAI-compatible `POST /v1/chat/completions`, plus `GET /v1/models`, `/metrics`
(Prometheus), `/health`, and `/openapi.json`. The full surface is reflected in
`GET /openapi.json`.

## License

From the `0.15.0` boundary, OwlCoda source is released under
**`GPL-3.0-or-later`**. Commercial, OEM, or embedded distribution uses a
separate license handled by the maintainer.

This repository is the public source, issue, release, and trust surface for GPL
releases. npm packages may ship compiled `dist/` only; see
[SOURCE.md](SOURCE.md) for the corresponding-source requirement. Historical
published versions keep the license they were published under.

## Links

- Website: [owlcoda.com](https://owlcoda.com)
- Issues & PRs: [github.com/yeemio/owlcoda/issues](https://github.com/yeemio/owlcoda/issues)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · Security: [SECURITY.md](SECURITY.md)

## Development

```bash
npm run dev     # tsx hot-reload
npm test        # run tests
npm run build   # TypeScript compile
```
