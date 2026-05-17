# Changelog

This public changelog tracks user-facing npm releases and public-router
changes. It does not mirror private implementation history or source commits.

Runtime version truth is the installed npm package:

```bash
owlcoda --version
npm view owlcoda version
```

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
