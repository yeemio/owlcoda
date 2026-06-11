# Changelog

All notable changes to OwlCoda public releases are documented here.

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
