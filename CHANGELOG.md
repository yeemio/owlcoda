# Changelog

This public changelog tracks user-facing npm releases and public-router
changes. It does not mirror private implementation history or source commits.

Runtime version truth is the installed npm package:

```bash
owlcoda --version
npm view owlcoda version
```

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
