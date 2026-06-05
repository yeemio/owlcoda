# Changelog

This public changelog tracks user-facing npm releases and public-router
changes. It does not mirror private implementation history or source commits.

Runtime version truth is the installed npm package:

```bash
owlcoda --version
npm view owlcoda version
```

## [0.14.59] - 2026-06-05

Project-scoped third-party skill enablement.

- Added `owlcoda skills add`, `owlcoda skills list`, and
  `owlcoda skills remove` for project-scoped third-party skill installation,
  inventory, and cleanup.
- Third-party skill installs are pinned and vendored into the project boundary
  with manifest records and integrity checks. OwlCoda loads the vendored copy
  rather than re-fetching at runtime.
- Added path traversal and out-of-tree vendored-path guards around the
  third-party skill installer and loader.
- `owlcoda skills list --json` now returns separate `learned` and
  `thirdParty` sections instead of a flat array.
- The cloud-model startup escape hatch introduced in 0.14.58 remains available
  when the default local runtime is unavailable.

## [0.14.58] - 2026-06-04

Cloud-model startup escape hatch.

- When the default model points at an unavailable local runtime but configured
  cloud models are available, bare `owlcoda` now prints the direct `-m` startup
  escape hatch and default-model guidance before opening Admin. This keeps
  users from getting trapped in the first-run shunt when a working cloud route
  is already configured.

## [0.14.57] - 2026-06-04

Slash picker hotfix, streaming cache-usage visibility, and local readiness
sampling.

- Slash commands typed with arguments, such as `/mode normal` or
  `/model <name>`, now submit correctly from the picker even when the visible
  fuzzy-match list is empty.
- Streaming responses now include final input-token and cache-read usage in the
  terminal `message_delta`, so downstream clients can see the same cache
  accounting OwlCoda uses internally.
- Added local JSONL telemetry-envelope plumbing for readiness diagnostics. This
  is local file output, not a hosted telemetry pipeline, and can be disabled
  with `OWLCODA_TELEMETRY_EVENTS=0`.
- Added Project Map day-0 shadow sampling for fresh/stale snapshot decisions;
  disable it with `OWLCODA_PROJECT_MAP_SHADOW=0`.
- Added Tier-1 fault-injection matrix coverage and an inline upstream 5xx probe
  to keep provider-runtime diagnostics visible in release gates.
- Daemon port-in-use errors now point at the local daemon log path and suggest
  `owlcoda service status` when service ownership may matter.

## [0.14.56] - 2026-06-03

Daemon/service resilience and Admin Models-as-home.

- The daemon now writes stdout/stderr to `~/.owlcoda/daemon.log` with rotation,
  making background lifecycle failures easier to diagnose.
- Request-handler crashes are isolated to the failing request instead of taking
  down the daemon process.
- `owlcoda service install|uninstall|status` adds opt-in macOS launchd
  KeepAlive management. Existing users are not enrolled automatically.
- launchd-started daemons self-register runtime metadata, and the CLI
  coordinates with launchd instead of spawning a second daemon.
- `OWLCODA_*` values, including `OWLCODA_HOME`, are persisted into the launchd
  plist for isolated service installs.
- Admin now opens on Models instead of a separate Start page. Empty installs
  show a direct add-model entry, and local runtime setup appears in the local
  model context.

## [0.14.55] - 2026-06-03

Admin model onboarding and terminal rendering hardening.

- Admin model setup now uses two clearer lanes: brand one-click providers for
  hosted models, and custom/local runtimes for Ollama, LM Studio, vLLM,
  owlmlx, OpenAI-compatible, and Anthropic-compatible endpoints.
- Switching from a hosted brand provider to a local runtime now clears stale
  cloud-template model fields.
- StartPage, Add Model, and edit fields now share a clearer bilingual labeling
  and advanced-field disclosure pattern.
- Terminal ambiguous-width detection reduces CJK/Terminal.app layout drift while
  keeping the default Western-width behavior. `OWLCODA_AMBIGUOUS_WIDTH` remains
  available as an explicit override.
- The startup width probe uses an alternate-screen scratch buffer so detection
  does not erase the user's main-screen row.

## [0.14.54] - 2026-06-03

Task progress guard and terminal rendering hardening.

- Task no-progress is now advisory by default instead of a default hard-stop;
  operators can still enable the legacy hard-stop with
  `OWLCODA_TASK_NO_PROGRESS_HARD_STOP=1`.
- Narration-loop detection now stops only repeated identical text-only replies,
  reducing false stops during ordinary investigation.
- Runtime stop messages no longer stack an extra generic “No response” fallback
  on top of deliberate guard exits.
- Curated multi-line runtime guidance is preserved in slash-command error
  rendering.
- Fallback prose splitting now measures terminal display cells, with additional
  CJK rendering regression guards.

## [0.14.53] - 2026-06-02

Slash-command completion, startup diagnostics, and provider-runtime hardening.

- `/copy`, `/hooks`, `/tasks`, and `/editor` are now registered in the visible
  command surface, with `/editor` using a guarded temporary-file flow.
- Prefix-cache token usage is now surfaced in per-model and session cost
  reporting.
- `owlcoda doctor` can warn when the npm registry has a newer OwlCoda version
  than the local install.
- Daemon recovery, router URL probing, OpenAI-compatible header timeouts, and
  bash-risk classification for `/dev/null` and standard streams were tightened.

## [0.14.52] - 2026-06-01

Task no-progress guard refinement for read-heavy investigation and plan mode.

- Task no-progress hard stops now respect active distinct-file read
  investigation while repeated or zero-signal reading remains guarded.
- Plan mode now suppresses execution-pressure hard stops and task-step nudges.
- Successful TaskCreate, TaskUpdate, and TaskOutput display is routed to the
  footer; errors remain visible.

## [0.14.51] - 2026-06-01

Bash progress ledger hardening for interpreter-inline writes.

- Bash artifact progress now uses the actual tool execution window so files
  written by interpreter-inline commands such as `python3 -c` can be credited
  by task no-progress checks.
- Interpreter-internal artifact writes can be grounded through filesystem mtime
  evidence, with `OWLCODA_BASH_FS_PROGRESS=0` available as an escape hatch.
- The behavior is intentionally conservative: old read-only file mentions are
  not counted, while very recent file mtimes can still be treated as progress.

## [0.14.50] - 2026-06-01

TUI rendering stability and evidence-ledger observability.

- Assistant narration is now flushed at tool boundaries and turn endings so
  buffered text does not glue itself to later output.
- Terminal scrollback rendering is steadier around warning-sign width handling
  and committed output lines that contain control characters.
- Evidence-ledger fidelity observability is available as a debug-only shadow
  surface for compaction and grounding review. It is not a default enforcement
  gate.

## [0.14.49] - 2026-05-31

Terminal.app Enter hotfix.

- macOS Terminal.app modifier-key detection now degrades safely when the
  optional native modifier addon is unavailable.
- Pressing Enter in Terminal.app no longer terminates the REPL before submit
  when native Shift-key detection cannot load.
- Normal Enter-to-submit behavior is preserved; Shift+Enter native detection
  remains best-effort.

## [0.14.48] - 2026-05-30

Terminal/PTY Ctrl+C input hotfix.

- Parsed Ctrl+C input from Terminal.app, Windows Terminal, and
  PowerShell-style terminals is now filtered out of the composer instead of
  appearing as a literal `c` draft character.
- Same-chunk Ctrl+C bursts such as `\x03\x03` now arm the exit confirmation
  once instead of immediately confirming exit.
- Normal separate-keypress "Ctrl+C again to exit" behavior is unchanged.

## [0.14.47] - 2026-05-30

Project Map runtime control plane and Permission Modes default-on cutover.

- `/mode` is now available by default. OwlCoda still starts in `normal` mode;
  choose `/mode auto` explicitly for low-risk auto approvals, or set
  `OWLCODA_MODES=0` to disable the mode surface.
- Project Map is now default-on with `OWLCODA_PROJECT_MAP=0` as the rollback
  override. It provides a bounded project snapshot, `/project-map`, headless
  JSON evidence, and task verification profile hints.
- Project Map snapshot failures are isolated so a scan failure does not break
  the conversation loop.
- Project Map freshness uses full-content hashes while keeping bounded
  evidence metadata.
- Project Map does not grant write permission; existing provenance,
  write-scope, deny, and headless approval gates remain authoritative.

## [0.14.46] - 2026-05-30

Opt-in permission modes, adaptive admission observability, and clearer
no-progress diagnostics.

- Permission Modes are available for dogfood behind `OWLCODA_MODES=1`, adding
  `/mode`, `--mode`, plan/normal/auto mode state, mode-gate telemetry, and
  auto-mode low-risk approvals. Default behavior is unchanged while the flag
  is unset.
- Adaptive sub-agent concurrency now has daemon-side admission coordination and
  a `GET /v1/admission` observability surface when
  `OWLCODA_AGENT_ADAPTIVE_CONCURRENCY=1`.
- `/cost` now reflects prompt-cache hits for OpenAI- and
  Anthropic-compatible usage paths.
- Task no-progress hard stops now explain the cause and name the relevant
  budget knob.

## [0.14.45] - 2026-05-29

Conversation-prefix prompt caching and CI gate speedup.

- Anthropic-compatible requests now mark the latest cacheable conversation
  block with an ephemeral cache breakpoint, improving prompt-cache reuse across
  multi-turn sessions.
- The main self-hosted CI gate no longer restores an oversized npm cache before
  install, keeping release verification inside the normal time budget.

## [0.14.44] - 2026-05-29

Opt-in adaptive sub-agent concurrency.

- Sub-agent fan-out can now adapt its concurrency to backend throttling. When
  enabled with `OWLCODA_AGENT_ADAPTIVE_CONCURRENCY=1`, the configured
  `OWLCODA_AGENT_MAX_CONCURRENCY` becomes a ceiling while OwlCoda slow-starts
  the active limit and backs off on rate-limit pushback.
- Default behavior is unchanged when the flag is unset. Cross-process daemon
  coordination remains out of scope for this patch.

## [0.14.43] - 2026-05-29

Language Server Protocol tool activation and context-window display patch.

- The LSP tool is now functional: it auto-starts a language server
  (TypeScript/JavaScript via `typescript-language-server`) per project and
  supports diagnostics, hover, definition, references, symbols, and
  completion. Previously the tool was registered but always reported
  unavailable. Unsupported file types and missing servers report clearly.
- Context-window sizes now display consistently across the status bar and
  model labels. Large windows render as e.g. "2M" instead of the
  misread-prone "2097.2k".

## [0.14.42] - 2026-05-28

Chat-completions routing, WebFetch fallback recovery, StructuredOutput
validation, and TUI rendering patch.

- `/v1/chat/completions` now preserves per-model routing so cloud and local
  model choices resolve through the intended backend.
- WebFetch can recover eligible 404 responses by using a site `llms.txt`
  fallback when available.
- StructuredOutput validates schema payloads before execution so malformed
  schemas fail with a compact validation error.
- Tool-start summaries render without raw JSON, and wrapped tool output keeps
  its indentation.

## [0.14.41] - 2026-05-28

Agent watchdog timeout handling, DuckDuckGo Lite parsing, and sub-agent
telemetry path-sample patch.

- Cooperative sub-agent watchdog exits now use the timeout classification path
  instead of falling through to a generic or no-deliverable result.
- WebSearch now parses the current DuckDuckGo Lite result markup, including
  single-quoted class attributes and redirect result URLs.
- `agent_invocation` telemetry now includes touched-path and expected-artifact
  path samples for file-collision investigation.

## [0.14.40] - 2026-05-28

Daemon version-drift guard, sub-agent runtime-failure isolation completion,
and compact validation-error rendering patch.

- Startup now blocks when an upgraded CLI is talking to an older resident
  daemon, preventing stale-daemon behavior from looking like a random runtime
  bug.
- If startup reports daemon version drift after upgrade, run
  `owlcoda stop --force && owlcoda`; the emergency bypass is
  `OWLCODA_ALLOW_VERSION_DRIFT=1`.
- The sub-agent runtime-failure path now preserves the isolation contract
  instead of escalating isolated sub-agent failures into the parent loop as
  terminal failures.
- Fast-validation tool errors now render as compact one-line diagnostics.

## [0.14.39] - 2026-05-28

Sub-agent failure contract hardening and observability patch.

- Loop guards no longer count isolated sub-agent failures as repeated parent
  failures of the same class.
- Isolated sub-agent failure output is structured for the parent model, with
  routing guidance it can read and act on.
- Add `agent_invocation` JSONL telemetry for sub-agent runs, including
  inferred-completion classification.
- This patch does not claim cross-process quota enforcement or a new
  orchestrator layer.

## [0.14.38] - 2026-05-28

Sub-agent isolation and provider retry patch.

- Isolated sub-agent failures no longer terminate the parent loop, and
  isolated-failure metadata is normalized across catch paths.
- HTTP 400 provider errors with rate-limit-shaped details retry through the
  normal recovery path.
- Sub-agent execution is throttled in-process by default to reduce bursty
  provider pressure; this does not claim multi-process quota enforcement.
- Successful DeliveryAudit output stays footer-only.

## [0.14.37] - 2026-05-28

Sub-agent failure isolation hotfix.

- Fix isolated sub-agent failures so they no longer terminate the parent
  conversation loop as `terminal_tool_failure`.
- True terminal tool failures keep their existing terminal path unchanged.

## [0.14.36] - 2026-05-27

Post-0.14.35 UX/noise patch.

- Route model-internal nudges to footer-only display so runtime guidance no
  longer pollutes transcript or the main user-visible message stream.
- No behavioral gate expansion is included in this patch.

## [0.14.35] - 2026-05-27

Write-target provenance gate flagged release.

- Add opt-in write-target provenance checks for native writes when
  `OWLCODA_GATE_PROVENANCE=1`; default behavior remains unchanged.
- Add release smoke coverage and telemetry helpers for reviewing provenance
  admit/block events during shadow dogfood.
- Document the flagged provenance workflow and settings rule shape for users
  testing the preview.
- Suppress task nudges while OwlCoda is awaiting an explicit user decision
  during permission review.

## [0.14.34] - 2026-05-26

Streaming transport-interruption hotfix.

- Report streaming response body socket closures after partial output as
  retryable `stream_interrupted` diagnostics with `partialOutputSeen: true`.
- Keep usable partial streaming output from being reclassified as a
  non-retryable unknown fetch failure when the provider transport closes
  mid-stream.

## [0.14.33] - 2026-05-26

Headless runtime policy and diagnostics hardening.

- Preserve raw non-JSON headless stdout without duplicating final text or adding
  terminal UI chrome in piped runs.
- Add explicit `--allow-tool` and `--deny-tool` filters for unattended runs;
  these narrow the approval policy without bypassing bash risk checks.
- Add headless approval-policy context and structured hard-stop diagnostics so
  unattended failures are easier to inspect.
- Mark Kimi Code as sustained-work capable in model recommendation and display
  surfaces.

## [0.14.32] - 2026-05-25

Gate V2 action-permission preview.

- Add an opt-in `OWLCODA_GATE_V2=1` gate path that records tool proposals,
  permission decisions, execution starts, settlements, and post-grant evidence.
- Classify tool risk more explicitly across read-only, internal-state, mutating,
  destructive, and external-effect tool calls.
- Keep the default gate behavior unchanged while the new path is tested behind
  the environment flag.

## [0.14.31] - 2026-05-23

SWE-bench task-progress recovery hotfix.

- Retry one bounded recovery pass when unattended benchmark generation stops
  with task-progress exhaustion and a zero-byte patch.
- Preserve inspected file context across macOS `/private/tmp` benchmark
  workspaces so the recovery pass can edit instead of repeating read-only
  exploration.
- Report task-progress recovery and timeout-empty-stdout outcomes separately in
  benchmark summaries.

## [0.14.30] - 2026-05-21

SWE-bench prediction hygiene hotfix.

- Keep empty benchmark patches in runner records and summaries without writing
  them into evaluation prediction files.
- Fail empty task-progress patches in sanity gates before downstream harness
  input is produced.

## [0.14.29] - 2026-05-21

Benchmark runner hygiene patch.

- Separate benchmark generation failures from evaluation prediction artifacts.
- Keep failed generation attempts out of prediction output files.
- Reduce local daemon port collisions during unattended benchmark batches.
- Steer unattended benchmark prompts toward bounded, early code edits.

## [0.14.28] - 2026-05-18

SWE-bench unattended runner throughput and approval hardening.

- Reuse shared repository mirrors and allow configurable benchmark concurrency
  so repeated SWE-bench runs spend less time re-cloning repositories.
- Record per-instance duration and post-patch timeout fields so slow runs are
  measured directly.
- Permit bounded workspace-local Python probes and test commands under
  unattended headless approval while still rejecting installs, network access,
  deletion, and shell writes.
- Preserve non-empty benchmark patches after a stable post-patch timeout
  instead of waiting indefinitely for final model narration.

## [0.14.27] - 2026-05-17

SWE-bench unattended scoring hardening.

- Treat task-guard stops as non-successful headless exits so empty benchmark
  patches are not recorded as successful predictions.
- Declare the active benchmark checkout as the bounded edit workspace for
  unattended SWE-bench runs.
- Allow workspace-local Django `tests/runtests.py`, pytest, unittest, and
  read-only diff checks under bounded auto-approval while still rejecting
  installs, network commands, shell writes, and out-of-workspace execution.

## [0.14.26] - 2026-05-17

Headless and benchmark automation hardening.

- Add an isolated SWE-bench Lite batch runner for local benchmark evaluation.
- Prevent unattended headless JSON runs from blocking on interactive questions.
- Flush large JSON run results more reliably before process exit.
- Allow focused workspace-local test commands for high-confidence code-change
  tasks under `--auto-approve` while preserving workspace boundaries.

## [0.14.25] - 2026-05-17

Headless runtime approval fix.

- Allow high-confidence workspace-scoped code-change tasks to use structured
  edit/write tools under `--auto-approve`.
- Keep structured mutations inside the active workspace boundary before they
  can run unattended.
- Preserve explicit-path approval behavior for artifact-scoped tasks.

## [0.14.24] - 2026-05-17

Release validation and benchmark-methodology hardening.

- Add evaluation methodology packets for benchmark runs so release reviewers
  can compare latency, throughput, and routing behavior with clearer evidence.
- Stabilize the full-suite slow lane and release-smoke path used before npm
  publication.
- Tighten task-execution validation around command risk, tool maturity,
  release gates, and artifact verification follow-through.

## [0.14.23] - 2026-05-15

Progress ledger hotfix.

- Count successful structured execution tools as task progress so durable tasks
  are not stopped while real work is happening.
- Detect more shell-created artifact evidence, including env-expanded paths,
  brace-created directories, `mkdir`, `npm --prefix`, and `tee $VAR/file`
  writes.
- Keep durable touched paths limited to explicit artifact outputs while still
  refreshing the progress window for execution activity.

## [0.14.22] - 2026-05-15

Runtime maturity and artifact verification release.

- Add benchmark, workspace, route-preview, and verification tools for more
  observable artifact-oriented tasks.
- Wire HTML deck verification packs through task verification so generated
  deliverables can carry structured checks.
- Tighten Admin model setup, provider probing, runtime truth, and fresh-install
  version surfaces for npm users.

## [0.14.21] - 2026-05-15

Long-running stream and handoff contract precision.

- Active streaming responses are no longer killed by the local request
  wall-clock timeout once the response body has started.
- First-token and idle watchdogs continue to detect genuinely stalled streams.
- Handoff deliverable filename lists and wrapped Markdown links no longer
  become cwd write targets by themselves.

## [0.14.20] - 2026-05-15

Long-task gate precision.

- Suggested artifact filenames are no longer treated as authorized write
  scopes unless the prompt also declares a concrete output location.
- Production nudges avoid naming reference or input files as task write
  targets.
- Durable artifact tasks without a structured task plan now get a TaskCreate
  nudge before broad reading turns into a no-progress hard stop.

## [0.14.19] - 2026-05-15

Task Execution Mode integration.

- Structured task plans can now guide longer native tasks through explicit
  creation, step nudges, and deterministic verification checks.
- Read-only review and chat-shaped work stay out of artifact progress gates,
  reducing false `task_no_progress` stops.
- Declared task outputs are checked against the artifact contract so progress,
  verification, and final deliverables stay aligned.

## [0.14.18] - 2026-05-14

Long-task progress guard hardening.

- User-declared external deliverable paths can now be tracked as task outputs
  when prompts explicitly say to output, save, or write to that path.
- External reference paths remain separate from authorized write targets, so a
  cited input file cannot become a writable bash artifact path.
- Low-confidence no-progress situations now fail open with telemetry instead
  of hard-stopping uncertain tasks.
- Gate telemetry records structured production-gate, no-progress, tool-loop,
  and write-scope-block decisions for later tuning.

## [0.14.17] - 2026-05-13

Progress-signal v2 for native runs.

- Bash and PowerShell artifact writes now count as run progress when they
  produce in-scope workspace outputs.
- Scratch artifacts outside the workspace refresh progress without being
  treated as final deliverables.
- Explicit write scopes now cover shell-produced workspace artifacts before
  dispatch, so shell writes follow the same guard as write/edit tools.
- Repeated failing bash commands now use exact command signatures and are
  deduplicated at the call level without weakening the broader loop guard.

## [0.14.16] - 2026-05-13

Endpoint-first Admin onboarding and skill-package support.

- Admin now presents cloud providers, custom endpoints, and local runtime
  presets in the first-run model setup flow, including endpoint health status
  and localhost discovery for supported local runtimes.
- `owlcoda init --endpoint` is the canonical CLI setup flag for local
  OpenAI-compatible endpoints. The older `--router` and `-r` flags remain
  accepted as legacy aliases.
- The product UI no longer exposes the old Runs tab; legacy `#/runs` Admin
  routes fall back to Start.
- Claude-style `SKILL.md` packages are recognized without `metadata.json`,
  imported with their `references/`, `scripts/`, and `assets/` directories,
  and preserved as raw Markdown when run.
- The npm package now includes curated skills so fresh installs can discover
  and use them immediately.

## [0.14.15] - 2026-05-12

Provider onboarding and transcript rendering cleanup.

- Cloud-provider setup now focuses on the supported brand presets: Kimi,
  DeepSeek, GLM, MiniMax, GPT, Claude, Gemini, Grok, plus explicit
  OpenAI-compatible and Anthropic-compatible custom channels.
- Admin saves provider/protocol hints and template headers with created cloud
  models, so a route that passes dry-run testing keeps the same semantics when
  used from the CLI.
- Transcript output now styles status summaries and report-style key/value
  rows consistently, and bash tool output strips cursor/OSC/progress redraw
  control sequences while preserving SGR colors.

## [0.14.14] - 2026-05-12

Admin version-truth hotfix.

- Admin now reads its header version from the running runtime snapshot
  instead of a stale frontend build constant.
- Historical run/report package labels are presented as historical report
  package versions, not the current Admin version.
- If a browser tab still shows an older localhost Admin after upgrading,
  stop the old OwlCoda process and start `owlcoda` again.

## [0.14.13] - 2026-05-12

Trial npm distribution update.

- OwlCoda is publicly installable through npm.
- Fresh installs do not include maintainer model configuration; users configure
  their own local runtime or cloud provider in Admin.
- The public repository is now a router for install docs, issues, changelog,
  security contact, and website links rather than the product source tree.
