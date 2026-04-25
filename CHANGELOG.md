# Changelog

All notable changes to OwlCoda are documented here.

Runtime version truth comes from [`package.json`](package.json) and is
exposed at runtime through [`src/version.ts`](src/version.ts) and
`owlcoda --version`.

## [0.1.0] — 2026-04-25

Initial public release. OwlCoda enters the public source tree as a
**Developer Preview** — feature-complete enough for daily use, but
the API surface, slash-command set, and config schema may still
evolve before 1.0.

### Native REPL
- Default interactive path: native REPL with 42+ built-in tools
  (Bash, Read, Write, Glob, Grep, MCP-served tools, more) and 69+
  slash commands.
- Selection-first transcript surface: terminal-native drag-select
  and copy stay available on the primary screen.
- Multi-client live REPL with a shared daemon, per-client session
  affinity, and live `clients list` / `clients detach` control plane.
- Session persistence under `~/.owlcoda/sessions/`, including
  `--resume id|last`, `/sessions`, `/tag`, `/branch`, `/history`.
- Headless mode: `owlcoda -p "..."` and `owlcoda run --prompt "..."`
  return end-to-end LLM responses with full tool support.

### Protocol & routing
- Anthropic Messages API ↔ OpenAI Chat Completions translation,
  including streaming + non-streaming + tool-use protocol.
- Multi-backend auto-discovery (Ollama 11434, LM Studio 1234, vLLM
  8000) and intent-aware routing across local + cloud catalogs.
- Production middleware: retry, rate-limit, fallback, circuit
  breaker, response cache (LRU 100 / 5 min TTL), per-model timeout
  override, hot config reload.

### Skills (L2)
- TF-IDF–matched skill injection from `~/.owlcoda/skills/` and
  the curated skill pack into the system prompt at request time.
- `owlcoda skills` CLI: `info / list / show / synth / delete /
  search / match / stats / cleanup / export / import`.
- Auto-synthesis pipeline that extracts reusable skills from
  complex completed sessions.

### Training data pipeline (L3, opt-in / off by default)
- Quality-scored session collection (5 weighted dimensions),
  PII sanitization before disk write, JSONL / ShareGPT / insights
  export formats. Disabled unless explicitly opted-in via
  `trainingCollection: true` in `config.json` or
  `OWLCODA_TRAINING_COLLECTION=1`.

### Browser admin
- `owlcoda ui` / `owlcoda admin` prints a one-shot admin URL.
- `--open-browser` to launch directly; `--route` and `--select`
  for focused handoffs to specific admin views.
- Provider failure diagnostics unified across main agent,
  subagent, `/v1/messages`, `/v1/chat/completions`, admin
  `test connection`, and `/warmup`.

### Diagnostics & observability
- `owlcoda doctor` — environment, runtime, and model health.
- `owlcoda config / validate / models / health / status / inspect /
  audit / cache / logs / benchmark / export`.
- HTTP API: `/v1/perf`, `/v1/latency`, `/v1/cost`, `/v1/recommend`,
  `/v1/usage`, `/v1/audit`, `/v1/cache`, `/v1/skills`,
  `/v1/insights/:sessionId`, `/v1/training/*`, `/v1/captures`,
  `/v1/search`, `/openapi.json`, `/metrics`.

### Privacy posture
- Sessions stay local under `~/.owlcoda/`. Training data
  collection is opt-in. Nothing is uploaded to any external
  service by OwlCoda itself.

### Known limitations
- Mouse-wheel transcript scrollback is not yet routed through the
  in-tree Ink fork. Use `PgUp` / `PgDn` / `Ctrl+↓` or `/history`
  for in-app scrollback.
- LSP tools require the user to install the corresponding
  language server (`typescript-language-server`, `pyright`,
  `rust-analyzer`, `gopls`, etc.) and wire it via a plugin.
- OAuth-style remote MCP servers are not yet supported; stdio MCP
  servers are fully functional.
