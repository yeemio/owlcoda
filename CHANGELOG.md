# Changelog

This public changelog tracks user-facing npm releases and public-router
changes. It does not mirror private implementation history or source commits.

Runtime version truth is the installed npm package:

```bash
owlcoda --version
npm view owlcoda version
```

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
