# OwlCoda

[English](README.md) · [中文](README.zh.md)

> **Your models. Your tools. Your data. A coding workbench you wire to
> the model fleet of your choice.**

OwlCoda is an independent, local-first AI coding workbench. It runs as
a native terminal REPL with 42+ built-in tools and 69+ slash commands,
and it accepts requests in the Messages-shaped API while routing them
to any OpenAI-compatible local runtime or to a cloud provider you
configure yourself.

> **Privacy by default.** Sessions stay in `~/.owlcoda/`. Training-data
> collection is **opt-in** (off by default) and PII-sanitized before
> anything ever touches disk. There is no OwlCoda server, no telemetry
> endpoint, no upload.

This is a **Developer Preview**. The CLI surface, slash-command set,
and config schema may still evolve before 1.0.

---

## Supported backends

OwlCoda does not ship its own model — you point it at one. Out of the
box it speaks to:

### Local runtimes (auto-detected by `owlcoda init`)

| Runtime | Default endpoint |
|---|---|
| [Ollama](https://ollama.com) | `http://127.0.0.1:11434/v1` |
| [LM Studio](https://lmstudio.ai) | `http://127.0.0.1:1234/v1` |
| [vLLM](https://github.com/vllm-project/vllm) | `http://127.0.0.1:8000/v1` |
| Any custom OpenAI-compatible router | user-supplied |

### Cloud providers (user-configured, BYO API key)

| Provider | Wire format | Endpoint |
|---|---|---|
| Kimi (Moonshot) | OpenAI-compatible | `https://api.moonshot.ai/v1` |
| Kimi Coding | provider-native | `https://api.kimi.com/coding` |
| MiniMax | Messages-shaped | `https://api.minimaxi.com/anthropic` |
| OpenRouter | OpenAI-compatible | `https://openrouter.ai/api/v1` |
| Alibaba Bailian / DashScope | OpenAI-compatible | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Anthropic | Messages-shaped | `https://api.anthropic.com` |
| OpenAI | OpenAI-compatible | `https://api.openai.com/v1` |
| Anything else | OpenAI-compatible / Messages-shaped | user-supplied |

Provider templates live in
[`src/provider-probe.ts`](src/provider-probe.ts); add or override
endpoints in `config.json`.

---

## Install OwlCoda

OwlCoda is currently distributed as source. npm / Homebrew / standalone
binary are planned for 1.0.

```bash
git clone https://github.com/yeemio/owlcoda.git
cd owlcoda
npm install
npm run build
npm link             # exposes `owlcoda` globally
```

Prerequisites: Node.js ≥ 18 (Node 20+ recommended), macOS / Linux /
Windows / Windows-WSL.

Windows note: default Git checkouts often use `core.symlinks=false`.
OwlCoda keeps build-critical Ink shim entrypoints as real TypeScript
bridge files rather than symlinks, so `npm install && npm run build`
works without enabling Developer Mode or changing Git symlink settings.

If `npm link` fails because your global npm prefix is not writable:

- `sudo npm link`, **or**
- `npm config set prefix ~/.local && export PATH=~/.local/bin:$PATH`,
  then re-run `npm link`, **or**
- skip the link and run `node /path/to/owlcoda/dist/cli.js …`.

---

## Configure your first backend

`owlcoda init` writes a starter `config.json`. It auto-detects whichever
local runtime is already listening on the standard ports above; if none
respond, it writes a placeholder you can edit.

You can also pass a router URL explicitly. A few examples below cover
the common cases.

### Local: Ollama

```bash
owlcoda init --router http://127.0.0.1:11434/v1
owlcoda
```

### Local: LM Studio

```bash
owlcoda init --router http://127.0.0.1:1234/v1
owlcoda
```

### Cloud: Kimi (Moonshot)

```bash
export KIMI_API_KEY=sk-...
owlcoda init --router https://api.moonshot.ai/v1
```

Then edit `config.json` to attach the key:

```json
{
  "routerUrl": "https://api.moonshot.ai/v1",
  "models": [
    {
      "id": "kimi-k2",
      "label": "Kimi K2",
      "backendModel": "moonshot-v1-128k",
      "endpoint": "https://api.moonshot.ai/v1",
      "apiKeyEnv": "KIMI_API_KEY",
      "aliases": ["default", "kimi"],
      "default": true
    }
  ]
}
```

### Cloud: MiniMax (Messages-shaped)

```json
{
  "routerUrl": "https://api.minimaxi.com/anthropic",
  "models": [
    {
      "id": "minimax-m27",
      "label": "MiniMax M2.7-highspeed",
      "backendModel": "MiniMax-M2.7-highspeed",
      "endpoint": "https://api.minimaxi.com/anthropic",
      "apiKeyEnv": "MINIMAX_API_KEY",
      "localRuntimeProtocol": "anthropic_messages",
      "aliases": ["default", "minimax"],
      "contextWindow": 204800,
      "default": true
    }
  ]
}
```

### Cloud: OpenRouter (multi-model gateway)

```json
{
  "routerUrl": "https://openrouter.ai/api/v1",
  "models": [
    {
      "id": "openrouter-default",
      "label": "OpenRouter selection",
      "backendModel": "qwen/qwen3-coder",
      "endpoint": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "aliases": ["default"],
      "default": true
    }
  ]
}
```

### Mixed local + cloud (multiple models in one config)

You can list as many models as you want, mix local and cloud, and pick
between them at runtime with `--model <alias>` or `/model` inside the
REPL:

```json
{
  "routerUrl": "http://127.0.0.1:11434/v1",
  "models": [
    { "id": "qwen-local", "backendModel": "qwen2.5-coder:7b",
      "aliases": ["default", "fast"], "default": true },
    { "id": "kimi-cloud", "backendModel": "moonshot-v1-128k",
      "endpoint": "https://api.moonshot.ai/v1",
      "apiKeyEnv": "KIMI_API_KEY",
      "aliases": ["heavy", "kimi"] }
  ]
}
```

`owlcoda --model heavy` → Kimi. Default → local Qwen.

See [`config.example.json`](config.example.json) for the full schema
and [`src/capabilities.ts`](src/capabilities.ts) for the runtime-
verified capability matrix.

---

## Common commands

```bash
owlcoda                          # native interactive REPL (default)
owlcoda -p "list all .ts files"  # headless one-shot
owlcoda --resume last            # resume the most recent session
owlcoda --model <alias>          # pick a model

owlcoda init                     # create config.json
owlcoda doctor                   # environment + backend health check
owlcoda config                   # show active config + resolved models
owlcoda models                   # list configured models + reachability

owlcoda start | stop | status    # background daemon lifecycle
owlcoda clients                  # list / detach live REPL clients
owlcoda ui --open-browser        # launch the browser admin

owlcoda skills [list|show|synth|search|match|stats|export|import]
owlcoda training [status|scan|report|export jsonl|sharegpt|insights]
owlcoda audit | cache | logs | inspect | benchmark | health | validate
```

`owlcoda --help` lists everything, grouped by area.

---

## Configuration reference

Environment variable overrides:

| Variable | Effect | Default |
|---|---|---|
| `OWLCODA_PORT` | OwlCoda HTTP port | `8019` |
| `OWLCODA_ROUTER_URL` | Backend router URL | from `config.json` |
| `OWLCODA_HOME` | Data dir | `~/.owlcoda` |
| `OWLCODA_LOG_LEVEL` | Log level | `info` |
| `OWLCODA_TRAINING_COLLECTION` | `0` / `1` (overrides config) | unset |

Per-model fields commonly used in `config.json`:

| Field | Purpose |
|---|---|
| `id` | Stable model id used in the API |
| `label` | Human-readable name shown in UI |
| `backendModel` | Model id the backend itself expects |
| `endpoint` | Per-model override of `routerUrl` |
| `apiKey` / `apiKeyEnv` | Cloud credential (literal or env var name) |
| `localRuntimeProtocol` | `auto` / `openai_chat` / `anthropic_messages` |
| `aliases` | Alternate names accepted by `--model` |
| `tier` | `fast` / `balanced` / `heavy` (UI grouping) |
| `default` | One model per config should be the default |

---

## Native REPL highlights

- **42+ tools** — Bash, Read, Write, Edit, Glob, Grep, MCP-served
  tools, agent dispatch, scheduling, plugins, …
- **69+ slash commands** — `/model`, `/cost`, `/budget`, `/perf`,
  `/doctor`, `/config`, `/trace`, `/tokens`, `/sessions`, `/skills`,
  `/dashboard`, … run `/help` inside the REPL for the full list.
- **Selection-first transcript** — drag-select and copy work like a
  normal terminal app.
- **Session persistence** — every conversation lands under
  `~/.owlcoda/sessions/`; resume any of them with `--resume <id>`.
- **Learned skills (L2)** — repeated workflows get extracted and
  re-injected on later matching tasks.
- **Training data pipeline (L3, opt-in)** — score and export
  high-quality sessions as JSONL / ShareGPT for local fine-tuning.

---

## Architecture, briefly

```
owlcoda CLI (src/cli.ts → src/cli-core.ts)
  → native REPL (src/native/)
    → 42+ tools + 69+ slash commands
      → OwlCoda HTTP server (src/server.ts)
        → translate (Messages-shaped API ↔ OpenAI Chat Completions)
          → your local runtime (Ollama / LM Studio / vLLM / custom)
              + the cloud providers you configured (Kimi / MiniMax /
                OpenRouter / Anthropic / OpenAI / Bailian / …)
```

Top-level directories: `src/` (runtime), `admin/` (browser admin
React app), `skills/` (curated methodology skill pack),
`scripts/` (smoke / build helpers), `tests/` (vitest suite).

---

## Development

```bash
npm run dev      # run src/cli.ts directly via tsx (no rebuild)
npm test         # vitest suite (~3450 tests, ~30s)
npm run build    # tsc → dist/, then cross-platform postbuild copy/setup
npm run smoke    # full smoke test against a real backend
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, conventions,
and how to send a PR.

---

## Privacy posture

- All session data, learned skills, and (if enabled) training data
  live under `~/.owlcoda/` on your machine.
- The training pipeline runs PII sanitization in
  [`src/data/sanitize.ts`](src/data/sanitize.ts) before any record
  is appended to `~/.owlcoda/training/collected.jsonl`.
- OwlCoda has no telemetry endpoint and makes no outbound requests
  except to the backends listed in your `config.json`.

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
