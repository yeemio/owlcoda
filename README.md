# OwlCoda

[English](README.md) · [中文](README.zh.md)

> **Your models. Your tools. Your data. Runs locally — no login, no cloud.**

OwlCoda is an independent, local-first AI coding workbench. A native
terminal REPL with 42+ built-in tools, 69+ slash commands, session
persistence, learned skills, and production-grade middleware — all on
your own machine. Works with Ollama, LM Studio, vLLM, and any
OpenAI-compatible local runtime, plus optional cloud providers you
configure yourself.

> **Privacy by default.** Sessions stay in `~/.owlcoda/`. Training-data
> collection is **opt-in** (off by default) and PII-sanitized before
> anything ever touches disk. Nothing is uploaded to OwlCoda servers
> because there are no OwlCoda servers.

This is a **Developer Preview**. The CLI surface, slash-command set,
and config schema may still evolve before 1.0.

---

## Quickstart (30 seconds, with Ollama)

If you have nothing installed yet:

```bash
# 1. A local model backend (Ollama is the cheapest path).
brew install ollama && ollama serve &
ollama pull qwen2.5-coder:7b

# 2. OwlCoda itself (source install — npm / Homebrew / standalone
#    binary planned for 1.0).
git clone https://github.com/yeemio/owlcoda.git
cd owlcoda
npm install
npm run build
npm link            # makes `owlcoda` available globally

# 3. Point OwlCoda at the local backend and start.
owlcoda init --router http://127.0.0.1:11434/v1
owlcoda
```

LM Studio users: replace `--router` with `http://127.0.0.1:1234/v1`.
vLLM users: `http://127.0.0.1:8000/v1`. Any OpenAI-compatible
endpoint works.

If `npm link` fails because your global npm prefix is not writable:

- `sudo npm link`, **or**
- `npm config set prefix ~/.local && export PATH=~/.local/bin:$PATH`
  then re-run `npm link`, **or**
- skip the link entirely and run `node /path/to/owlcoda/dist/cli.js`.

---

## Prerequisites

- Node.js ≥ 18 (Node 20+ recommended).
- A local OpenAI-compatible inference backend (Ollama / LM Studio /
  vLLM / any custom router) — required for local-only operation.
- macOS, Linux, or Windows (WSL recommended on Windows).

---

## Common commands

```bash
owlcoda                          # native interactive REPL (default)
owlcoda -p "list all .ts files"  # headless one-shot
owlcoda --resume last            # resume the most recent session
owlcoda --model fast             # pick a model by alias / partial id

owlcoda init                     # create config.json (auto-detects backend)
owlcoda doctor                   # environment health check
owlcoda config                   # show active config + resolved models
owlcoda models                   # show configured models + runtime visibility

owlcoda start | stop | status    # background daemon lifecycle
owlcoda clients                  # list / detach live REPL clients
owlcoda ui --open-browser        # launch the browser admin

owlcoda skills [list|show|synth|search|match|stats|export|import]
owlcoda training [status|scan|report|export jsonl|sharegpt|insights]
owlcoda audit | cache | logs | inspect | benchmark | health | validate
```

`owlcoda --help` lists everything, grouped by area.

---

## Configuration

`owlcoda init` writes `config.json` with a sensible default. To edit
manually, copy the example:

```bash
cp config.example.json config.json
```

Minimum schema:

```json
{
  "port": 8019,
  "host": "127.0.0.1",
  "routerUrl": "http://127.0.0.1:11434/v1",
  "responseModelStyle": "platform",
  "models": [
    {
      "id": "qwen2.5-coder:7b",
      "label": "Qwen2.5 Coder 7B",
      "backendModel": "qwen2.5-coder:7b",
      "aliases": ["default", "fast"],
      "tier": "fast",
      "default": true
    }
  ],
  "trainingCollection": false
}
```

Environment variable overrides:

| Variable | Effect | Default |
|---|---|---|
| `OWLCODA_PORT` | Listen port | `8019` |
| `OWLCODA_ROUTER_URL` | Router URL | `http://127.0.0.1:8009` |
| `OWLCODA_HOME` | Data dir | `~/.owlcoda` |
| `OWLCODA_LOG_LEVEL` | Log level | `info` |
| `OWLCODA_TRAINING_COLLECTION` | `0` / `1` (overrides config) | unset |

See [`src/capabilities.ts`](src/capabilities.ts) for the
runtime-verified capability matrix (the one that actually reflects
what works) and [`config.example.json`](config.example.json) for the
full config schema.

---

## Native REPL highlights

- **42+ tools** — Bash, Read, Write, Edit, Glob, Grep, MCP-served
  tools, agent-spawning, scheduling, plugins, and more.
- **69+ slash commands** — `/model`, `/cost`, `/budget`, `/perf`,
  `/doctor`, `/config`, `/trace`, `/tokens`, `/sessions`, `/skills`,
  `/dashboard`, `/why-native`, ... — `owlcoda --help` and `/help`
  list them all.
- **Selection-first transcript** — drag-select and copy work the
  way they do in any other terminal app.
- **Session persistence** — every conversation is saved under
  `~/.owlcoda/sessions/`; resume any of them with `--resume <id>`.
- **Learned skills (L2)** — repeated workflows get extracted into
  reusable skills and re-injected on later matching tasks.
- **Training data pipeline (L3, opt-in)** — score and export
  high-quality sessions as JSONL / ShareGPT for local fine-tuning.

---

## Architecture, briefly

```
owlcoda CLI (src/cli.ts → src/cli-core.ts)
  → native REPL (src/native/)
    → 42+ tools + 69+ slash commands
      → OwlCoda HTTP server (src/server.ts)
        → translate (Anthropic Messages ↔ OpenAI Chat Completions)
          → your local runtime (Ollama / LM Studio / vLLM / custom)
              + optional cloud providers you configure yourself
```

Top-level directories: `src/` (runtime), `admin/` (browser admin
React app), `skills/` (curated methodology skill pack),
`scripts/` (smoke / build helpers), `tests/` (vitest suite).

---

## Development

```bash
npm run dev      # run src/cli.ts directly via tsx (no rebuild)
npm test         # vitest suite (~3450 tests, ~30s)
npm run build    # tsc → dist/, also chmod +x dist/cli.js
npm run smoke    # full smoke test against a real backend
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, conventions,
and how to send a PR.

---

## Privacy posture

- All session data, learned skills, and (if enabled) training data
  live under `~/.owlcoda/` on your machine. Nothing is uploaded.
- The training pipeline runs PII sanitization in
  [`src/data/sanitize.ts`](src/data/sanitize.ts) before any record
  is appended to `~/.owlcoda/training/collected.jsonl`.
- OwlCoda has no telemetry endpoint and makes no outbound requests
  it has not been explicitly configured to make. The `routerUrl` in
  your config is the only network destination unless you configure
  additional providers.

---

## License

Apache License 2.0 — see [`LICENSE`](LICENSE) and [`NOTICE.md`](NOTICE.md).

OwlCoda incorporates a fork of [vadimdemedes/ink](https://github.com/vadimdemedes/ink)
(MIT) under `src/ink/`. The original Vadim Demedes copyright is
preserved in [`NOTICE.md`](NOTICE.md) and at
[`src/ink/ATTRIBUTION.md`](src/ink/ATTRIBUTION.md), and a copy
travels with every published tarball at `dist/ink/ATTRIBUTION.md`.

---

## Contributing & support

- Issues and feature requests: GitHub Issues on this repository.
- See [`CONTRIBUTING.md`](CONTRIBUTING.md) before sending substantial
  PRs — the codebase moves fast and a quick issue first saves both
  sides time.
- Security reports: see [`SECURITY.md`](SECURITY.md).
