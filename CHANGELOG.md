# Changelog

All notable changes to OwlCoda are documented here.

Runtime version truth comes from [`package.json`](package.json) and is
exposed at runtime through [`src/version.ts`](src/version.ts) and
`owlcoda --version`.

## [0.1.5] — 2026-04-28

Public router release for admin readiness polish and native completion-guard hardening, sourced from private commit `a9b9479`.

### Admin
- Add the Runs view and first-run readiness polish used by the public admin workflow.
- Surface snapshot freshness and the public router version in the admin header.

### Runtime
- Treat sustained-work final reports with elapsed time, checkpoints, tests, cleanup, fallback, repo-change status, and remaining-risk evidence as durable task completion.
- Keep write-intended tasks conservative when explicit path scope has not produced file changes yet.

### Release Routing
- Preserve the public package line at `0.1.5`; private-only website source, brand source assets, and execution prompts remain excluded from `main`.

## [0.1.4] — 2026-04-26

Public router security and cmux stress-path hardening release, sourced from the private source line.

### Security
- Deny unsafe headless tools by default unless explicitly auto-approved, and expose approval decisions in headless output.
- Add write/edit/NotebookEdit filesystem guardrails that reject path escapes, sensitive locations, and symlink escapes before mutation.
- Centralize bash risk classification and route headless, TUI permission warnings, and legacy runtime bash checks through the same policy.

### Reliability
- Stop parent continuation after terminal sub-agent failures so incomplete agent runs do not invite model improvisation.
- Make sub-agent iteration budgets explicit: Explore defaults to 80 iterations, general-purpose agents default to 200, and explicit overrides remain honored.
- Add low-churn terminal detection for cmux-style mediated terminals and document the escape hatch.

## [0.1.3] — 2026-04-26

Public trust-surface cleanup for the published router repo.

### Changed
- `README.md` / `README.zh.md` and model-workbench tests use
  neutral "user-configured Messages-shaped provider" wording instead
  of naming one upstream vendor as a built-in public backend.
- `skills/collaboration/writing-plans/SKILL.md` now refers to a
  generic executor instead of a host-app-specific assistant name.
- `scripts/postbuild.mjs` removes generated `dist/**/*.map` files
  after build so the published package stays focused on runtime
  artifacts.

### Added
- `NOTICE.md` documents methodology-pack attribution for adapted
  public skills and names the upstream ecosystems whose patterns
  influenced the curated OwlCoda skill pack.

## [0.1.2] — 2026-04-25

User-facing README rewrite + second-pass legal-positioning polish.

### Changed
- `README.md` / `README.zh.md` rewritten to put OwlCoda first:
  installation, supported backend matrix (local: Ollama / LM Studio /
  vLLM; cloud: Kimi / Moonshot / MiniMax / OpenRouter / Bailian /
  OpenAI / user-configured Messages-shaped providers / custom), and concrete config snippets per
  provider. The previous README read as an Ollama tutorial; the new
  one reads as the OwlCoda manual it should be.
- `admin/src/pages/StartPage.tsx` — the local-runtime protocol
  picker option labeled `Anthropic messages` is now `Messages-shaped
  API`; the help text references "Anthropic-compatible providers
  and similar gateways" rather than naming a single vendor.
- `tests/provider-probe.test.ts` — third-party model name fixtures
  replaced with neutral `messages-vendor-*` names.
- `skills/collaboration/{using-git-worktrees, phase-prompting,
  receiving-code-review}/SKILL.md` — generic `AGENTS.md` /
  `instruction` phrasing replaces the host-app-specific filename
  that the original methodology pack used.

### Added
- `skills/README.md` — explicit positioning of the in-tree pack as
  an OwlCoda curated methodology pack, with a non-list of
  third-party SaaS skills that intentionally do not ship here.

### Removed
- `skills/meta/` — the maintenance / governance scripts under
  `gardening-skills-wiki`, `pulling-updates-from-skills-repository`,
  `sharing-skills`, `testing-skills-with-subagents`, and
  `writing-skills` were tooling for an upstream skill-pack
  ecosystem, not user-facing capability. Several of them carried
  hardcoded host paths that pointed at an external maintainer's
  local checkout.

## [0.1.1] — 2026-04-25

Legal-positioning and provenance polish. No runtime behavior change.

### Removed
- `skills/collaboration/remembering-conversations/` — depended on a
  third-party AI agent SDK at runtime and on a host-app hook
  directory for deployment, neither of which fit OwlCoda's
  independent posture. Users who want conversation-recall workflows
  should install a third-party skill pack rather than ship one
  in-tree.
- `skills/debugging/systematic-debugging/CREATION-LOG.md` — extraction
  log referencing a third-party developer's home directory; not
  user-facing content.

### Changed
- `NOTICE.md` adds a "Protocol Interoperability vs Affiliation"
  section that explicitly disclaims any partnership / endorsement /
  derivative-work claim with respect to third parties whose wire
  formats OwlCoda implements (Messages-shaped API, OpenAI Chat
  Completions). The `@anthropic-ai/sdk` `devDependency` is
  documented as an interoperability test artifact, not a runtime
  dependency.
- `README.md` / `README.zh.md` architecture diagram says
  "Messages-shaped API" instead of naming a single upstream vendor,
  matching the protocol-not-affiliation posture.
- `skills/collaboration/using-git-worktrees/SKILL.md`,
  `skills/debugging/root-cause-tracing/SKILL.md`, and
  `scripts/smoke-presentation.mjs` had hardcoded third-party
  developer paths and model names replaced with neutral
  `/Users/example/...` and generic model identifiers.

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
