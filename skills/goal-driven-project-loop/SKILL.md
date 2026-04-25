---
name: goal-driven-project-loop
description: Use when a software project is mature enough to run as a goal-driven execution loop instead of manual round-by-round prompting. This skill turns a high-level goal into a goal contract, selects the next dominant gap, generates the next execution round, archives it, and decides whether to continue, branch, stop as blocked, or escalate to the user.
---

# Goal-Driven Project Loop

Use this skill when the user wants a project to run in a goal-driven loop rather than through manually authored one-off rounds.

This is a general project skill. It is not specific to any one project.

Use it when the project already has enough structure that autonomous iteration is more valuable than repeated manual prompting.

Typical signs the project is ready:

- source-of-truth docs or stable project conventions exist
- the codebase already has tests or runnable checks
- prior delivery summaries, milestones, or release notes exist
- the user wants continued self-directed execution toward one goal
- the project has enough operational truth that the next best step can be selected from evidence

Do not use this skill for:

- tiny one-off bugfixes
- greenfield projects with no stable truth yet
- projects where every next step still depends on hidden user preferences

## What this skill does

This skill adds the outer loop:

- define the goal contract
- freeze current truth
- identify the dominant remaining gap
- generate the next execution round
- archive the round prompt
- decide whether to continue, branch, stop as blocked, or escalate

This skill does not replace domain-specific execution skills. It coordinates them.

## Load only what is needed

Always load enough local truth to answer:

1. What is the actual goal?
2. What is already verified?
3. What is still blocked?
4. What evidence exists for the next step?

Prefer:

- project root instructions (`AGENT.md`, `README`, contributor docs, design docs)
- test/config/build files
- current verification assets or changelogs
- the most recent archived prompts or delivery summaries

Do not bulk-load the whole repo.

## Core loop

Every goal-driven cycle follows this order:

1. `Freeze`
   - restate the goal
   - restate current verified truth

2. `Assess`
   - identify remaining gaps
   - identify the one dominant gap that most limits the goal

3. `Select`
   - choose one next round
   - split into A/B only if a genuine branch is needed

4. `Generate`
   - write the next round prompt
   - archive it in the project

5. `Execute`
   - run the actual implementation and verification work

6. `Verify`
   - require tests, assets, or other proof
   - update honest claims

7. `Decide`
   - continue
   - branch
   - stop as blocked
   - escalate to the user

## Goal contract requirements

Before running a loop, define a goal contract.

Use [references/goal-contract-template.md](references/goal-contract-template.md).

Every goal contract must define:

- `goal_id`
- `title`
- `success_definition`
- `blocked_definition`
- `hard_rules`
- `out_of_scope`
- `current_truth`
- `remaining_gaps`
- `dominant_next_gap`

Do not continue with a vague “keep iterating” request unless you can safely derive the goal contract from the repo and user context.

## Gap selection rules

Choose the next round using this order:

1. fix false claims or truth mismatches
2. close the main runtime, product, or architecture blocker
3. productize a proven but fragile path
4. close the most visible user-facing or operator-facing gap
5. then optimize or expand

Do not choose a flashy optimization while a more fundamental blocker is still open.

## Branching rules

Create branch prompts only when:

- the next step genuinely depends on an uncertain result
- both branches still serve the same goal
- branching avoids wasted work

Do not branch just because multiple things could be improved.

## Continue vs escalate

Default to continuing autonomously.

Return to the user only when:

1. the goal contract is ambiguous or contradictory
2. two materially different paths require business or product priority
3. an external dependency becomes the blocker
4. a risky action needs explicit approval
5. the goal is reached or cleanly blocked

## Stop rules

### Success stop

Stop only when the goal's success definition is satisfied.

### Blocked stop

Stop as blocked only if:

- the blocker is exact
- the blocker is written down honestly
- the next external jump is clear

### Bad stop

Do not stop with:

- “probably done”
- “good enough for now”
- “next round later” without a blocker contract

## Prompt generation rules

When generating the next round:

- keep it to roughly `2-3 hours`
- choose one dominant delivery objective
- require runnable verification
- require a final delivery summary
- archive the prompt in the project

Use the project's own domain skill if one exists.

## Archiving rule

Archive the generated prompt in a project-local location.

Preferred project-local patterns:

- `prompts/`
- `docs/execution-prompts/`
- `files/execution-prompts/<project>/`

If the project already has a prompt archive convention, follow it.

## Required outputs per cycle

Each cycle should leave behind:

- a goal contract
- the next round prompt
- a delivery summary
- updated tests/assets/docs as appropriate

## Relationship to domain skills

This skill is the outer loop.

It chooses the next round.
The project-specific delivery workflow executes it.

## Final answer behavior

When using this skill, answer in terms of:

- current goal
- current dominant gap
- next round selected
- whether execution should continue automatically after it

Do not default back to manual round-by-round prompting unless the user explicitly wants that mode.
