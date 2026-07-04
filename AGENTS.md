# OwlCoda Agent Working Guidelines

These instructions apply to every AI agent working in this repository. More
specific `AGENTS.md` files in subdirectories may add narrower rules for that
tree, but they must not weaken the safety, verification, or release-truth rules
in this file.

OwlCoda already loads project instruction files in this order:

```text
AGENTS.md
CLAUDE.md
OWLCODA.md
.owlcoda/OWLCODA.md
```

Use this file as the repository-level working contract. It follows the same
idea as Codex `AGENTS.md` and Claude Code `CLAUDE.md`: durable project guidance
that is loaded into agent context. It is not a substitute for tests, hooks,
review gates, or release gates.

## What OwlCoda Is

OwlCoda is a local-first coding agent runtime harness. Its job is to make agent
work executable, inspectable, recoverable, and reviewable.

The product boundary is:

- OwlCoda CLI/runtime: execution harness, tools, workflow, receipts, artifacts,
  task verification, structured output, provider routing, and recovery.
- OwlCoda App Server/Desktop/RunKit: desktop shell, runtime rail, app-server
  protocol, review surface, packaging, signing, diagnostics, and release
  readiness.
- Memory line: recall, project memory, candidates, and evidence-linked learning.
- Domain products such as OwlFootball: business contracts, domain judgment,
  market semantics, user-facing product logic, and final domain decisions.

Do not move domain business logic into OwlCoda. OwlCoda should make model and
tool execution trustworthy; domain products decide what the evidence means.

## Communication

- Start with the conclusion. The first sentence should answer what happened or
  what the result is.
- Write for a teammate who just came back to the desk. Do not rely on private
  nicknames, hidden context, or unexplained shorthand.
- Prefer clear prose over dense arrows, excessive tables, or process jargon.
- Be honest about status. If a test failed, say it failed and include the key
  output. If something was skipped, say it was skipped.
- For small questions, answer directly. Do not create a ceremony around simple
  facts.

## Autonomy

- If the request is actionable and the scope is clear, do the work instead of
  asking whether to do it.
- Ask before destructive operations, force pushes, deleting data, changing
  credentials, publishing packages, or broadening the requested scope.
- When the user is asking for analysis, status, review, or product judgment,
  deliver the judgment and stop. Do not start editing code unless asked.
- If a task fails, retry and investigate before handing the problem back.
- Do not end with a plan that you could have executed safely in the same turn.

## Worktree Discipline

- The OwlCoda private checkout is often dirty. Treat existing modified or
  untracked files as user or parallel-session work unless proven otherwise.
- Never revert changes you did not make unless the user explicitly requests it.
- Before editing a file, read the relevant surrounding code or document.
- Keep edits scoped to the requested lane. Do not mix CLI, RunKit/Desktop, Mem,
  OwlFootball, release, and website changes in one unstated batch.
- Do not stage, commit, push, tag, publish, or deploy unless the user explicitly
  asks for that action.
- Use clean worktrees or clean clones for release candidates, public syncs, and
  reviewable implementation branches. Do not publish from a dirty private
  checkout.

## Implementation Discipline

- Prefer the existing architecture and local helper APIs over new abstractions.
- Make the smallest complete change that solves the problem.
- Do not refactor unrelated code while fixing a bug.
- Do not add feature flags, compatibility layers, adapters, or fallback systems
  for imagined future needs.
- Do not change product logic merely to make tests pass.
- Add code comments only for intent, constraints, or tradeoffs that the code
  cannot express clearly.
- Use structured parsers and typed contracts where available. Avoid brittle
  string manipulation at system boundaries.

## Verification

- Do not claim "done", "fixed", "passed", or "release-ready" before running
  verification.
- For code changes, run the narrow focused tests first, then the broader gate
  appropriate to the risk.
- For TypeScript/runtime work, prefer these checks when relevant:

```bash
npx tsc --noEmit --pretty false
git diff --check
npm run release:smoke
```

- For release candidates, also verify package metadata, build output, npm pack
  contents, installed package behavior, public source/tag truth, GitHub Release
  truth, and website truth as separate surfaces.
- If full verification is too expensive or blocked, state exactly what was run,
  what was not run, and why.

## Runtime Truth Rules

- Runtime truth beats transcript appearance. Prefer receipts, artifacts,
  task-store state, runtime events, scorecards, logs, and saved JSON over model
  summaries.
- A failed task must still leave useful evidence: raw output, attempts, stop
  reason, fallback status, artifact refs, and validation errors when available.
- Completion claims require evidence. A polished final answer is not proof that
  the task is complete.
- Long tasks must preserve state through checkpoints, receipts, replacement
  history, and resumable artifacts. Do not rely on memory or transcript summary
  alone for recovery.
- Structured output should be treated as an artifact contract: parsed status,
  schema validity, usability, raw text, repair/salvage/fallback state, and
  attempts must remain inspectable.

## Release Truth

- Local checkout state is not release truth.
- Release truth is the combination of npm registry, package metadata, public
  source commit/tag, GitHub Release, installed package smoke, and website state.
- Private docs, execution prompts, RunKit WIP, Mem WIP, desktop WIP, demo labs,
  and domain-product follow-ups must not leak into public npm or public source
  unless explicitly selected.
- Version bumps, changelog edits, tags, public syncs, and website deployment are
  release actions. Do not perform them without explicit release authorization.

## Lane Boundaries

- CLI/runtime harness work belongs to the OwlCoda CLI lane.
- Desktop/App Server/RunKit productization belongs to the RunKit/Desktop lane.
- Memory kernel work belongs to the Mem lane.
- OwlFootball work belongs in the OwlFootball repository unless the request is
  explicitly about a generic OwlCoda harness capability.
- A control-tower session coordinates, audits, and writes dispatch or acceptance
  documents. It should not absorb implementation work that belongs to another
  active session unless the user explicitly reassigns it.

## Documentation And Handoff

- Write durable decisions into repo-local docs when they need to drive another
  session or survive context compaction.
- Handoff documents should include the objective, branch/worktree, changed
  files, verification commands and results, remaining gaps, risks, and the next
  dominant gap.
- Specs should be executable: success definition, non-goals, acceptance checks,
  failure modes, and delivery summary location.
- Keep user-facing Owl ecosystem product and strategy docs Chinese-first unless
  the surrounding public repository convention clearly requires English.

## External References

- Browse or otherwise verify current external facts when the answer depends on
  changing product docs, APIs, versions, laws, prices, releases, or market state.
- Prefer primary sources: official documentation, source repositories, release
  notes, and standards.
- When referencing OpenAI or Codex behavior, use official OpenAI documentation
  or verified local behavior.
- When referencing Claude Code behavior, use official Anthropic documentation
  where possible.

## Tooling

- Use `rg` / `rg --files` for search.
- Use `apply_patch` for manual file edits.
- Parallelize independent file reads or searches.
- Do not use shell write tricks to create or edit source files.
- Do not run destructive commands such as `git reset --hard`, `git checkout --`,
  or broad deletes unless explicitly requested.

## Security And Secrets

- Do not print, persist, or commit secrets.
- Do not use Developer ID certificates, Apple notarization credentials, GitHub
  release tokens, npm publishing, or production deployment credentials without
  explicit authorization.
- Any telemetry, collection, external network egress, or privacy-sensitive
  feature must be opt-in, documented, and disable-able.
