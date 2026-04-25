---
name: Phase Prompting
description: Turn verified project state into execution-ready phase prompts with wave structure, hard rules, acceptance criteria, and delivery reports. For writing prompts that drive real implementation progress, not design docs.
when_to_use: when writing execution prompts, round plans, phase delivery packets, or multi-wave coordination plans for any project. Especially when the prompt will be handed to another session or executor.
version: 1.1.0
languages: all
---

# Phase Prompting

## Overview

This skill turns current verified project state into execution-ready prompts. The output is a prompt that another session (or the same session later) can pick up and execute with zero additional context.

**Announce at start:** "I'm using the Phase Prompting skill to write the execution prompt."

**Core principle:** Write from current truth, not from summaries. If code and docs disagree, trust code.

## When to use

- Writing a phase/round/task prompt for implementation work
- Creating a multi-wave execution packet
- Writing a follow-on phase after reviewing delivery summaries
- Any time a prompt will be handed to an executor who has zero conversation context

## First principles

These are non-negotiable:

- `running code > design document`
- `verified state > claimed support`
- `one executable round > one giant roadmap`
- `honest blocked state > fake green`
- `concrete file paths > vague references`

## Prompt archiving is mandatory and project-scoped

When you produce a complete execution-ready prompt, do not leave it only in chat.

- Save the final prompt into the project repo unless the user explicitly says not to.
- Archive prompts under a project-specific directory, not a shared flat folder.
- Archive root convention: `<project-repo>/prompts/` or
  `<project-repo>/docs/execution-prompts/`
- If the directory does not exist, create it.
- If you are writing prompts for a project not listed above, create and use an appropriate directory within that project's repo.
- Use deterministic filenames:
  - `task-19-round-2-verify-and-commit.md`
  - `phase-8-upstream-full-capability.md`
  - `phase-40-round-7.md`
  - `phase-40-round-7a.md` (branch variant)
  - `phase-40-round-7-revision.md` (revision of existing)
- Archive the final prompt only, not chain-of-thought or scratch analysis.
- If you materially revise an already-archived prompt in the same turn, update the file instead of creating near-duplicates unless the user clearly wants a separate branch prompt.
- In your final answer, include the saved file path.

## Before writing: gather truth

Always do this before drafting:

1. Read the project's source-of-truth docs (CLAUDE.md, README, architecture docs)
2. Read the actual implementation files relevant to the task
3. Check git log for recent changes in the area
4. If delivery summaries exist, verify claims against code

**If summaries and code disagree, trust code, tests, and live behavior.**

## Prompt structure

Follow this skeleton. Every section is mandatory unless marked optional.

```
# Phase XX Round Y: [One-line delivery goal]

## Identity

You are [role]. Your task is not [anti-goal] but [real goal].

## First principles

- [3-5 hard rules as inequalities: X > Y]

## Current verified state

### What already works
- [Only list verified facts, with evidence]

### Key gaps
- [What actually blocks delivery]

## This round's goal

[One sentence. One dominant delivery objective.]

## Must-read files

1. [Absolute path]
2. [Absolute path]
3. [Absolute path]

Read these first. Output a <10 line execution plan before touching code.

## Hard rules

- Do not [specific anti-pattern]
- Do not [specific anti-pattern]
- [Runtime/safety constraints if applicable]

## Wave plan

| Wave | Goal | Time |
|------|------|------|
| 0 | Baseline freeze | 10m |
| 1 | [First real action] | 30m |
| 2 | [Second real action] | 30m |
| 3 | [Surface/gate/test sync] | 20m |
| 4 | [Verification and closeout] | 15m |

## Wave 0: [Title]

Goal: [One line]

Tasks:
- [Concrete task with file path]
- [Concrete task with file path]

Acceptance:
- [Observable, verifiable result]

## Wave 1: [Title]

[Same structure]

## Wave N: [Title]

[Same structure]

## Required tests

- [Exact command to run]
- [Exact command to run]

## Out of scope

- [Explicit exclusion]
- [Explicit exclusion]

## After each wave, answer these 4 questions

1. What real capability did the user gain?
2. What false claim was removed or corrected?
3. What formal gate or verification was added?
4. What still blocks delivery?

## Final delivery report format

### Modified files
- [list]

### Wave-by-wave outcomes
- Wave 0: [one line]
- Wave 1: [one line]

### New user-visible capabilities
- [list]

### Tests run
- [command + result]

### Build/check run
- [command + result]

### Release-readiness delta
- [one line]

### Remaining blockers
- [list]

### Why this round advances delivery
- [one line]

## Commit message

[Project] vX.Y.Z -- Phase XX round Y [short summary]
```

## Writing rules

### Round sizing

One round should be:

- 2-3 hours of execution time
- 3-7 waves
- One dominant delivery goal
- Branch conditions when outcome is uncertain

If the next step depends on whether A passes or fails, write Round 2A and Round 2B, not one oversized prompt.

### Wave quality

Good waves:

- Fix a real broken path
- Replace an overclaim with verified truth
- Turn a doc concept into a real gate
- Sync API, UI, protocol, and tests across layers

Weak waves (avoid these):

- "review some files"
- "polish docs"
- "clean up naming"
- "do more validation" with no delivery objective

### Every round must create real user value

Do not write rounds that mostly rename things, restate earlier work, add surface labels without runtime truth, or repeat already-proven chains.

### Force multi-layer progress

Unless scope is explicitly narrowed, each round should advance:

- Backend/core behavior
- At least one user-facing surface
- Tests
- Docs or protocol or verification assets

### Capability honesty

Always distinguish and label:

- `supported` -- verified working
- `partial` -- works with caveats
- `best_effort` -- may work, not guaranteed
- `blocked` -- known broken, with reason
- `unsupported` -- not applicable

Never let a prompt reward inflated claims.

### Branching rules

When the round depends on a high-risk result:

```
If [condition A succeeds]:
  -> proceed to Wave 3A: [productize it]
If [condition A fails]:
  -> fall back to Wave 3B: [alternative path]
If [prerequisite missing]:
  -> mark blocked, close honesty gap first
```

Do not make later waves depend on a success path that may never happen.

### Constraint writing

Write constraints as hard negations, not suggestions:

- "Do not expand scope beyond [X]"
- "Do not write inferred as verified"
- "Do not add design docs"
- "Do not modify [specific file] unless [specific condition]"

### File references

Always use repo-relative paths. Never write "the config file" when you can write `src/config.ts`. Repo-relative paths read the same regardless of where the repo lives on disk.

### Anti-repeat rule

If the prior round overclaimed or repeated earlier work, write the anti-repeat rule directly into the prompt:

- "Wave 1 of Phase 5 already verified X. Do not re-verify."
- "The following paths are already proven: [list]. Skip them."

## Heuristics

- If the prior round overclaimed, make honesty closure the first job
- If the problem is strategic, write a sharper round, not a larger round
- If a round risks repeating earlier work, write the anti-repeat rule into the prompt
- Prefer "blocked with reason" over vague "flaky" language
- Use exact file paths, explicit acceptance criteria, concrete dates
- One round that closes one real gap beats three rounds that touch everything lightly

## Output

When using this skill, produce one of:

- A complete execution-ready prompt (most common)
- A split plan: roadmap + Round 1 prompt + branch prompts
- A revision of an earlier phase prompt that tightens truth, scope, and gates

The output should be ready to hand to an executor with zero additional conversation context, and by default should be archived under the correct project directory.
