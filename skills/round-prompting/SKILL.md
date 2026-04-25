---
name: Round Prompting
description: Write focused single-round execution prompts for autonomous iteration — the atomic unit of phase-prompting.
---

# Round Prompting

Use this skill when writing a **single execution round** — the atomic unit of work within a larger phase. A round is typically 2-3 hours, 5-7 waves, with one dominant delivery goal.

For multi-round phase planning, see `phase-prompting`.
For local LLM platform-specific rounds, see `local-llm-phase-prompting`.

## When to Use

- You need to write the **next round** of autonomous iteration
- A phase prompt exists but the next concrete step needs scoping
- You're resuming work after a break and need to capture current state → next action

## Round Structure

```
# Round N: <Verb> <Object> — <Measurable Outcome>

## Current State (verified)
- What works right now (cite test counts, commit hashes)
- What is partially done (be specific about gaps)
- What is blocked (and by what)

## Goal
One sentence: what is different when this round is done?

## Waves

### Wave 1: <name> (~XX min)
- Task 1: <specific action>
- Task 2: <specific action>
- Checkpoint: <how to verify wave success>

### Wave 2: <name> (~XX min)
...

### Wave N: Verify + Commit (~10 min)
- Run full test suite
- Verify no regressions
- Commit with descriptive message
- Update progress tracking

## Hard Rules
- <rule 1>
- <rule 2>

## Branch Conditions
- If <condition>: <alternative path>
- If blocked on <X>: skip to Wave N, note blocker

## Out of Scope
- <thing that might be tempting but isn't this round>

## Done When
- [ ] <measurable criterion 1>
- [ ] <measurable criterion 2>
- [ ] Tests pass (count: N → N+M)
- [ ] Committed and pushed
```

## Writing Rules

### 1. Start from Verified State
Never write "Current State" from memory. Run commands, check test output, read recent commits. Cite evidence.

### 2. One Goal Per Round
If you have two goals, you have two rounds. Split them.

### 3. Every Wave Has a Checkpoint
A wave without a checkpoint is a wave that can silently fail. The checkpoint should be verifiable (test passes, command output, file exists).

### 4. Time-Box Waves
Estimate time per wave. If a wave exceeds estimate by 2x, it's a signal to split or simplify.

### 5. Branch Instead of Bloat
If Wave 3 depends on Wave 2 succeeding, write an explicit branch:
- **If Wave 2 passes**: proceed to Wave 3
- **If Wave 2 fails**: pivot to Wave 3-alt (diagnose + minimal fix)

### 6. Close with Verification
The final wave always includes: run tests, verify no regressions, commit, update tracking. Never skip this.

## Anti-Patterns

| Anti-Pattern | Fix |
|---|---|
| "Improve X" (vague) | "Add 3 tests for edge case Y in X" (specific) |
| 10+ waves | Split into 2 rounds |
| No checkpoints | Add verification after each wave |
| Goal depends on external response | Mark as blocked, write alternative round |
| Repeating previous round's work | Check commit log before writing |

## Example

```markdown
# Round 131: Wire skill match into system prompt — auto-inject on task start

## Current State (verified)
- Skill store: 49 skills, CRUD + export/import working (1618 tests)
- TF-IDF matcher: scoreMatch() returns top-N skills by relevance
- System prompt injection: not yet wired (translate/request.ts untouched)
- Last commit: b49f581 (Round 130)

## Goal
When a new task starts, automatically match relevant skills and inject
their guidance into the system prompt sent to the backend LLM.

## Waves

### Wave 1: Injection point (~20 min)
- Add injectSkillContext() to src/translate/request.ts
- Takes task description, returns augmented system prompt
- Checkpoint: unit test passes for injection with 0, 1, 3 skills

### Wave 2: Auto-match trigger (~30 min)
- Hook into onRequest plugin to extract task context
- Call matcher → inject top 3 skills above threshold 0.3
- Checkpoint: integration test with mock skill store

### Wave 3: Verify + Commit (~10 min)
- npx vitest run — all green
- Manual test: run the harness with a task that should trigger the debugging skill
- Commit: "feat: auto-inject matched skills into system prompt — Round 131"

## Hard Rules
- Never inject more than 3 skills (context budget)
- Threshold 0.3 minimum (avoid noise)
- Log injected skills to session meta (observability)

## Branch Conditions
- If matcher returns 0 results: proceed without injection (no-op)
- If system prompt exceeds 4000 tokens after injection: truncate oldest skill

## Out of Scope
- Embedding-based matching (future round)
- User-configurable skill preferences

## Done When
- [ ] Skills auto-injected on task start
- [ ] Integration test passes
- [ ] Tests: 1618 → 1625+
- [ ] Committed and pushed
```
