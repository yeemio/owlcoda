# Model requirements (native Agent / REPL)

OwlCoda’s default experience is a **tool-using coding agent**: the native REPL
sends dozens of tool definitions on each turn. That is a different product shape
than “chat with a small local model” in Ollama, LM Studio, or similar apps.

This page applies to **all platforms** (macOS, Linux, Windows). It is not a
Windows-only limitation.

## What OwlCoda expects

| Expectation | Why |
|-------------|-----|
| **Tool / function calling** | The runtime must accept a `tools` array (or equivalent) on chat requests. |
| **Enough capacity for multi-tool agents** | Small models may accept tools in theory but fail in practice (latency, quality, or hard errors). |
| **Configured `backendModel` matches the runtime** | e.g. `qwen2.5:7b` in `ollama list`, not a display alias only. |

## Recommended local models (Agent / REPL)

| Tier | Parameter size | Guidance |
|------|----------------|----------|
| **Recommended** | **≥ 8B** | Default recommendation for local Agent use (e.g. `qwen2.5:7b`, `llama3.1:8b`, `qwen2.5-coder:7b`). |
| **Experimental floor** | **~7B** | May work on capable GPU hosts; not guaranteed on CPU-only machines. |
| **Not supported for Agent** | **&lt; 7B** (1B–4B class) | Fine for direct runtime chat (`ollama run …`), **not** for OwlCoda’s native REPL. |

Examples that are **poor fits** for Agent mode (common on Ollama):

- `gemma3:1b`, `gemma2:2b` — often **do not support tools** → upstream `400` / “does not support tools”.
- `qwen2.5:1.5b`, `qwen3:4b` — may support tools in isolation, but **full OwlCoda tool payloads** on CPU can exceed proxy time limits and feel “broken” compared to a one-line `ollama run` chat.

## Cloud providers

Use a model tier your provider documents for **tools / function calling**. The
same “small chat model” vs “agent model” distinction applies in the cloud.

## What to use instead of a sub-8B local model

1. **Agent work in OwlCoda** — pull/configure **≥ 8B** tool-capable model, or use a cloud provider in Admin.
2. **Lightweight local chat only** — use your runtime directly (`ollama run …`, LM Studio UI, etc.), not `owlcoda` REPL.
3. **Verify** — `owlcoda doctor` and `owlcoda models` after changing config.

## Configuration checklist (local runtime)

```text
routerUrl     → host base only, e.g. http://127.0.0.1:11434 (no trailing /v1)
backendModel  → exact id from ollama list / runtime catalog
models[]      → at least one entry; default model should meet the tiers above
```

See [install.md](install.md) and [troubleshooting.md](troubleshooting.md).

## Product note (npm package)

This public router documents **supported expectations**. Enforcing minimum model
tiers in Admin / `owlcoda doctor` (warn or block) is a product change in the
`owlcoda` npm package — track via [GitHub Issues](https://github.com/yeemio/owlcoda/issues).
