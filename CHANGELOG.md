# Changelog

All notable changes to OwlCoda public releases are documented here.

## [0.15.22] — 2026-07-04

Runtime reliability and observability repair release.

### Added

- Added gateway audit data to `/v1/perf`, including auth failure counts, status
  counts, gateway success rate, usable output rate, and zero/thin/slow output
  counters.
- Added dashboard and `/dashboard` slash command warnings for gateway and
  usable-output health problems.
- Added `ToolDisplayLifecycle` so TUI tool start/end rendering pairs by runtime
  tool IDs, with same-name FIFO fallback when IDs are unavailable.
- Added structured `active_step_conflict` repair hints for recoverable
  `TaskUpdate` step-state conflicts.

### Changed

- `POST /v1/messages` now fails fast with `404 not_found_error` when a request
  names an explicit unknown model, instead of silently falling back to another
  configured model.
- BrowserJob default artifacts now live under `~/.owlcoda/browser-jobs` instead
  of the project root `.owlcoda-browser-jobs` directory.
- `owlcoda stop --force` now prints the live REPL client and session details it
  is about to detach.
- Plan mode tools now keep the shared `operatingModeState.mode` and legacy
  `PlanModeState.inPlanMode` synchronized under `OWLCODA_MODES`.

### Fixed

- Redacted Bash stdout, stderr, progress lines, provider thinking fields,
  bearer/API tokens, URL tokens, long hex tokens, and common cloud/provider
  secret shapes before tool output reaches the transcript.
- Stored long Bash output as a redacted artifact and returned an `artifactRef`
  instead of flooding context.
- Truncated oversized Grep lines and total Grep output with metadata, and capped
  full-file Read output for large files with guidance to continue by range.
- Kept recoverable `web-fetch:http-403` failures from escalating into terminal
  semantic failures, and avoided treating successful JSON quota wording as a
  terminal failure.
- Rejected `owlcoda serve --port ... &` launched from REPL Bash with guidance to
  use lifecycle commands instead.
- Avoided misclassifying macOS `/home/...` paths mapped through the data volume
  as sensitive `/System` paths.

### Notes

- This release is a CLI/runtime reliability fix. It does not include
  RunKit/Desktop, Mem, demo-lab, OwlFootball business logic, or private
  execution prompts in the npm package.

## [0.15.21] — 2026-07-04

Auditable instruction chain loading release.

### Added

- Added layered built-in, user, and project instruction loading with an
  auditable source chain.
- Added `owlcoda instructions inspect --json` and human-readable instruction
  inspection output for release and runtime audits.
- Added `sources`, `skipped`, and `limits` audit surfaces so operators can see
  which instruction files were read, skipped, capped, or failed.
- Added package coverage for root `AGENTS.md` and
  `docs/INSTRUCTION_CHAIN.md`.

### Fixed

- Empty `~/.owlcoda/AGENTS.md` now explicitly blocks Codex fallback instead of
  silently reviving built-in defaults.
- Broken instruction symlinks are reported as `read-error` rather than being
  invisible.
- `AGENTS.override.md` and path-scoped `.claude/rules` files now record skip
  reasons in the audit chain.

### Notes

- This release does not include RunKit, Mem, OwlFootball business logic, or
  private execution prompts in the npm package.

## [0.15.20] — 2026-07-04

Provider streaming delta and agent working guidelines release.

### Added

- Added provider-level streaming delta support for `POST /v1/structured-output`
  when the resolved model declares streaming support and the request provides a
  positive `idleTimeoutMs`.
- Added activity-aware structured-output timeout handling so usable text/content
  deltas refresh the idle timer while heartbeat-only or thinking-only streams do
  not count as usable output.
- Added streaming attempt metadata such as provider SSE mode and delta source,
  while keeping non-streaming structured-output calls on the existing JSON
  compatibility path.
- Added root `AGENTS.md` with OwlCoda repository-level working guidelines for
  dirty checkout handling, release truth, lane boundaries, verification
  discipline, runtime truth, and safety expectations.

### Changed

- Extended model capability metadata with declared streaming support so
  structured-output routing can decide whether to use provider SSE or remain on
  non-streaming transport.
- Updated CLI harness governance receipts and runtime evidence surfaces for
  structured-output, workflow, and browser-job recovery paths.

### Fixed

- Preserved partial structured-output text when a provider stream interrupts
  after usable output has started.
- Kept thinking-only provider output as non-usable for completion, while still
  preserving thinking text for diagnostics and fallback artifacts.

### Notes

- This release does not include RunKit, Mem, OwlFootball business logic, or
  private execution prompts in the npm package.

## [0.15.19] — 2026-07-02

Workflow consumer harness read surface.

### Added

- Added `WorkflowConsumerManifest v1`, a read-only manifest surface for
  workflow runs that lets consumers inspect runtime truth without parsing
  natural-language transcripts.
- Added `owlcoda workflow list --json` and
  `owlcoda workflow inspect --run-id <id> --json` for scriptable workflow run
  discovery and inspection.
- Added App Server read methods `workflowRun/list` and `workflowRun/read`, plus
  typed client helpers for desktop or external consumers.
- Added workflow outcome facts to scorecard and trajectory surfaces so consumer
  layers can reason over execution outcomes as structured runtime facts.

### Fixed

- Tightened final-report gating around workflow receipts, required-step
  failures, missing artifacts, skipped steps without reasons, and structured
  output failed-fallback artifacts.

### Notes

- This is a generic runtime harness capability. It is not OwlFootball-specific
  and does not include RunKit, Mem, or OwlFootball business logic.

## [0.15.18] — 2026-06-27

Release-blocking reliability fixes.

### Fixed

- `TaskVerify` now separates retryable check failures from unsatisfiable or
  verdict-blocked failures, and returns structured repair checkpoints with
  next-action guidance instead of pushing models into blind workarounds.
- `TaskCreate` and `TaskUpdate` now reject verification policies that would
  require unsafe verification commands before the task is accepted.
- `TodoWrite` and `TaskUpdate` preserve `blocked` and `skipped` task states,
  require a reason for skipped work, and no longer count skipped or blocked
  steps as completed.
- `WebFetch` 403 responses are recoverable evidence failures instead of
  terminal research dead ends.
- `BrowserJob` preserves partial artifacts for selector misses and capture
  failures, so follow-up recovery can inspect the evidence that did land.
- Bash and long-task timeout reporting now surfaces incomplete snapshots rather
  than letting watchdog timeouts be summarized as completed work.
- `ReadMcpResource` routes `file://` and absolute filesystem paths through the
  file reader, reducing MCP-tool misuse dead ends.
- Structured-output capability handling no longer treats fallback
  `maxOutputTokens` as a hard cap over an explicit caller `maxTokens`; only
  declared or manual model limits cap the request.

### Notes

- This release closes the currently exposed release-blocking reliability defects
  around verification, recovery evidence, and structured-output provider
  controls. It does not claim all deeper platform issues are permanently solved.

## [0.15.17] — 2026-06-27

Resumable workflow runner release.

### Added

- Added `WorkflowRun`, a native resumable workflow runner for multi-step plans
  with persisted workflow state, step outcomes, and recovery metadata.
- Registered `WorkflowRun` across the native tool registry, CLI command
  surfaces, completions, tool risk classification, and public tool docs in the
  same release slice.

### Changed

- Multi-step workflow execution can now move through the runtime/tool layer
  instead of relying on transcript-only task memory.

### Notes

- This release keeps the `0.15.16` runtime harness consolidation boundary and
  adds the reviewed WorkflowRun P0 slice. It does not claim complete resolution
  of long-running degradation.

## [0.15.16] — 2026-06-27

Runtime harness consolidation release for the Phase D entry point.

### Added

- Added the `owlcoda/desktop` package export for desktop-shell consumers.
- Added desktop product-shell view models, live event adapters, smoke probes,
  runtime facts drilldown, and capability gating for App Server driven shells.
- Added provider evaluation and scorecard surfaces for RL-ready run accounting:
  default provider selection, headless audit/runner, report generation,
  persistent eval records, and scorecard adapters.
- Extended the structured-output harness with artifact persistence, app-server
  access, role-level rerun support, provider matrix checks, and desktop-facing
  artifact APIs.

### Changed

- Release validation now treats the runtime harness as the product boundary:
  execution, artifacts, provider capability, scorecard, and desktop surfaces are
  verified together before public packaging.

### Fixed

- Hardened long-task recovery, runtime event accounting, model capability
  routing, multimodal image message handling, job supervision, markdown
  normalization, and review-center partial apply paths covered by the expanded
  release gate.

## [0.15.7] — 2026-06-14

Packaging-hygiene release. No runtime change from 0.15.6.

### Fixed

- The published tarball is now built from a clean `dist/`. A `prebuild` step
  removes `dist/` before every build, so compiled output whose source has been
  deleted can no longer linger. This removes six stale dead-code files from the
  removed stub tools (`repl`, `schedule-cron`, `send-message`) that had been
  shipping — unregistered and unreachable — since 0.15.5. 0.15.6 remains
  published but carries those phantom files; 0.15.7 supersedes it with a clean
  tree.

## [0.15.6] — 2026-06-14

Command-surface refinement release: fewer, clearer slash commands and keyboard
mode switching.

### Added

- **Shift+Tab cycles the operating mode** (`normal → auto → plan`; `yolo` stays
  explicit), with the mode rail updating live as you cycle.

### Changed

- Consolidated the slash-command surface. `/config` now absorbs everything
  `/settings` showed (approval mode, theme, persistent always-allow), and five
  pure-duplicate commands were removed: `/settings`, `/color`, `/tokens`,
  `/reset-circuits`, `/reset-budgets`. The old names still work — they print a
  friendly "use X instead" redirect rather than erroring.
- `/reset` now combines both former reset commands, and observability output
  folds into `/status`. `/mode` with no arguments explains every mode.

### Fixed

- Slash-command fuzzy search matches the command **name** first, so typing a few
  letters of a command finds it instead of being buried under description
  matches.

### Notes

- Ships FIFA Phase 2 for the `worldcup-predictor` demo to the public source
  mirror: deterministic post-match data backfill that feeds an honest tactical
  prior into the pre-match brief (combines with, never overrides, pre-match
  evidence). The demo lives under `demo/` and is excluded from the npm package.

## [0.15.5] — 2026-06-14

Safety release: closes the gates through which a code-executing command could run
without the approval the active operating mode promised.

### Security

- **HIGH — unattended headless `--mode yolo` ran dangerous bash without the
  deny-gate.** In headless runs, mode auto-approve was overriding the headless
  safety deny-gate, so a destructive command could execute with no human present.
  The deny-gate now survives mode auto-approve: dangerous bash is blocked even
  under `--mode yolo`, while read-only and workspace-test commands still pass.
- **Task sub-agents no longer bypass the approval gate by delegation.** A parent
  could hand a dangerous command to a spawned sub-agent, which ran with no
  approval callback at all. Dangerous bash in a sub-agent is now gated like the
  parent's, closing the delegation bypass.
- **Wrong-case tool names no longer slip past the risk and mode gates.** A model
  emitting `Bash` (instead of canonical `bash`) sidestepped the destructive-
  command gate. Tool names are now canonicalized in the risk, mode, headless,
  write-scope, intent, and TUI gates, and in the persistent "Always allow" store
  (a wrong-case grant previously never stuck).

### Fixed

- Startup `--mode yolo` no longer desyncs the auto-approve mirror, and `/mode`
  and `/plan` clear that mirror so you can switch back out of yolo.
- `/mode` copy advertises `yolo`, and the `/plan` hint is accurate and gated on
  whether modes are enabled.

### Notes

- Ships the `worldcup-predictor` daily auto-review (self-grading loop) v1 demo to
  the public source mirror. The demo lives under `demo/` and is excluded from the
  npm package; the runtime change in this npm release is the safety hardening
  above.

## [0.15.4] — 2026-06-13

Dogfood-driven harness fixes, operating-mode consolidation, and a sub-agent model override.

### Added

- Sub-agents can run on a different model than their parent: the `Agent` tool
  takes an optional `model`, resolved as `input.model` > `OWLCODA_SUBAGENT_MODEL`
  > parent — so an orchestration sub-agent need not share the parent's backend.
- Admin "test connection" now shows the endpoint's real reported model version.

### Changed

- Unified the operating-mode surface: `/mode`, `/yolo`, `/approve`, and `/plan`
  all write one shared mode state that the permission gate reads.
- Removed three non-functional stub tools (`repl`, `schedule-cron`,
  `send-message`).

### Fixed

- Tool dispatch is case-insensitive, so a model emitting `Bash` instead of the
  canonical `bash` no longer fails with `unknown tool`.
- A bare `cd` is classified as a safe read-only command instead of being gated.
- Tightened bash risk classification so commands that execute code are not
  mislabeled read-only: `python -m pytest … -v` (pytest's *verbose* flag, not a
  version check) and `env VAR=val <cmd>` now classify by what they actually run.
- `ReadMcpResource` recovers from common mistakes: it coerces parameter aliases,
  lists the keys it received, and redirects a `file://` URI to `Read`.
- The loop guard now catches cross-turn accumulation of the same failure class
  (keyed by tool + failure category), and `TaskVerify` flags unsatisfiable
  checks so the guard stops futile re-verification.
- "Step not found" errors from the task tools now list the available step ids.

## [0.15.3] — 2026-06-12

Interrupt-recovery and rendering hotfix.

### Fixed

- Interrupting a tool loop and submitting a new message no longer poisons the
  session with deterministic 400s: merged consecutive user turns now keep
  `tool_result` blocks first, and an outbound wire guard re-orders any
  non-conforming body as a last line of defense.
- IME pre-edit no longer renders one row above the composer: the declared
  cursor origin is clamped to the terminal's physical bottom row.
- Ordered-list numbering resets at headings, code fences, and tables, and
  honors an explicit start number — long CJK documents no longer continue
  a previous list's counter.

### Added

- Render-incident capture: on a render-path throw, the raw-chunk ring buffer
  is persisted to a dump for diagnosis.

## [0.15.2] — 2026-06-11

Transcript chrome, compaction-resilience, and protocol-hygiene release.

### Added

- Transcript chrome S1–S3: collapsed tool results with a unified ok/err shape
  and an `/expand` toggle; narration `●` gutter with merged action+result
  groups and hanging-indent wrapping; one-line notices, a merged turn footer,
  and shared key-value slash panels (including `/cost`).

### Fixed

- Emergency heap-pressure compaction no longer erases task context: task
  anchors stay pinned, an ineffective-cut breaker stops repeated zero-value
  cuts, and a heap-significance gate skips conversations too small to matter,
  with pressure diagnostics for each decision.
- Orphaned `tool_use`/`tool_result` pairs are stripped at the send chokepoint,
  preventing deterministic 400 loops after interruptions; the daemon now dumps
  4xx request shapes for diagnosis.
- Long CJK ordered-list items are no longer split mid-item and renumbered by
  the fallback sentence splitter.
- Headless runs fail loudly when a model emits tool-call markers that never
  executed, instead of reporting silent success.
- Unknown models now default to a 200k context window instead of 32768, and
  `mimo-v2.5` models are recognized at 1M.

## [0.15.1] — 2026-06-11

First npm package release on the GPL source line.

### Changed

- Moved the public npm install line from the historical `0.14.x` stream to
  `0.15.x`.
- Added the post-source-open runtime fixes already shipped through `0.14.64`
  to the public source line, including mode visibility, submission recovery,
  terminal width hardening, headless exports, third-party skill hardening, and
  streaming usage accounting.
- Synced the bilingual README and Admin model screenshot into the npm package
  surface.
- Updated package metadata, lockfile metadata, Admin display version, and
  corresponding-source wording for `0.15.1`.

### Notes

- Paired with public source tag `v0.15.1`.

## [0.15.0] — 2026-06-04

License boundary and public source availability.

### Changed

- Relicensed the OwlCoda core package from `Apache-2.0` to
  `GPL-3.0-or-later` starting with the `0.15.0` boundary.
- Added `SOURCE.md` to make the corresponding-source requirement explicit for
  npm packages that ship compiled `dist/`.
- Updated package metadata, lockfile metadata, OpenAPI license metadata,
  README distribution posture, product truth, NOTICE, CONTRIBUTING, and
  SECURITY docs for the GPL source line.

### Notes

- Commercial, OEM, or embedded distribution is handled through a separate
  maintainer license path.
- Historical published versions remain under the license terms that accompanied
  those versions when they were published.

## Older Releases

Historical package versions remain under the license terms that accompanied those versions when they were published.
