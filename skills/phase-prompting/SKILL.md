---
name: Phase Prompting
description: Turn verified state into execution-ready prompts with wave structure, hard rules, acceptance criteria, and honest capability labels.
---

# Phase Prompting

Use this skill when the task is to write or revise:

- a phase prompt
- a round prompt
- a multi-wave execution packet
- a sustained coordination plan for executors
- a follow-on phase after reviewing delivery summaries or gate records

## Core Principle

**Write from current truth, not from assumptions.** Start from what is already verified, distinguish what is only inferred, call out overclaimed, and identify what still blocks delivery.

## Standard Prompt Shape

Follow this structure:

1. Phase / round title
2. Identity and mission
3. First principles
4. Current real state
5. Key gaps
6. Must-read files
7. Hard rules
8. Wave plan with estimated time
9. Wave-by-wave tasks
10. Required tests and build checks
11. Verification assets / gate records
12. Out-of-scope list
13. Final output format
14. Commit message

## Operating Rules

### 1. Write from Current Truth

Start from:
- what is already verified
- what is only inferred
- what is overclaimed
- what still blocks delivery

Do not write prompts that assume a summary is correct when code or live behavior says otherwise.

### 2. Prefer One Execution Round Over One Giant Roadmap

The actual prompt handed to an executor should usually be one round:
- about `2-3 hours`
- about `5-7 waves`
- with one dominant delivery goal
- with explicit branch conditions when the round can split

If the next step depends on whether `A` passes or fails, write `Round 2A` and `Round 2B` instead of one oversized prompt.

### 3. Every Round Must Create Real User Value

Do not write rounds that mostly:
- rename things
- restate earlier work
- add surface labels without runtime truth
- repeat already-proven chains

Prefer rounds that close one real gap:
- a path becomes truly runnable
- a false capability claim becomes honest and user-visible
- a long-task path becomes truly deliverable
- a benchmark or release gate becomes real

### 4. Force Multi-Layer Progress

Unless explicitly narrowed, each round should try to advance:
- backend or orchestration behavior
- at least one user entry surface
- tests
- docs or protocol or verification assets

### 5. Capability Honesty is Mandatory

Require prompts to distinguish:
- `supported`
- `partial`
- `best_effort`
- `manual-only`
- `blocked`
- `unsupported`

Never let a prompt reward inflated claims.

### 6. Runtime Safety Must Be Explicit

For heavy operations, long context, or risky changes, prompts should include:
- resource guard expectations
- isolated runtime rules when needed
- laddered verification instead of blind escalation
- blocked outcomes as valid outcomes

### 7. Prompt Archiving is the Default

When producing an execution-ready prompt:
- Save the final prompt into the project repo unless explicitly told not to
- Archive prompts under a project-specific directory
- Use deterministic filenames: `phase-XX-round-Y.md`, `phase-XX-round-Ya.md`, `phase-XX-round-Y-revision.md`
- Archive the final prompt only, not chain-of-thought

## Wave-Writing Rules

For each wave, include:
- goal
- why this wave matters
- concrete tasks
- acceptance criteria

**Good waves:**
- fix a real broken route
- replace an overclaim with a real verified path
- turn a doc concept into a real gate
- sync API, UI, protocol, and tests

**Weak waves:**
- "review some files"
- "polish docs"
- "clean up naming"
- "do more validation" without a delivery objective

## Branching Rules

When the round depends on a high-risk result, write the branch into the prompt:

- if primary path passes, proceed to productize it
- if it fails, fall back to alternative approach
- if blockers exist, mark blocked and close honesty first

Do not make later waves depend on a success path that may never happen.

## Required Final Report Sections

Every prompt should require a final report with:

- `Modified files`
- `Wave-by-wave outcomes`
- `New user-visible capabilities`
- `New/updated APIs`
- `Tests run`
- `Build/check run`
- `Release-readiness delta`
- `Remaining blockers before delivery`
- `Why this phase materially advances toward delivery`

## Output Expectation

When using this skill, produce one of:
- a complete execution-ready prompt
- a split plan: roadmap plus `Round 1` prompt plus branch prompts
- a revision of an earlier phase prompt that tightens truth, scope, and gates

The output should be ready to hand to an executor with minimal editing.
