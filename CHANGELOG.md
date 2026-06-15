# Changelog

All notable changes to OwlCoda public releases are documented here.

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
