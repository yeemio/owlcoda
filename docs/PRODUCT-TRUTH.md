# OwlCoda Product Truth

> Last updated: 2026-05-12
> Scope: product identity, distribution posture, mode hierarchy, and documentation authority

---

## Identity

OwlCoda is an **independent local AI coding platform**.

It is not:

- a proxy wrapper for some other product
- a temporary compatibility shell pretending to be the end state
- a future training product waiting for downstream infrastructure

It already combines:

- local-model execution and routing
- production middleware
- session intelligence
- skill learning
- training-data asset collection
- an increasingly complete native frontend

The most accurate short description is:

**OwlCoda is a local-first AI coding platform with a native frontend as its only product path.**

---

## Product Path

OwlCoda has one product path:

### Native

Role:

- owned frontend path
- primary mode
- convergence target for new work

What it is for:

- exposing OwlCoda-specific strengths directly in the product
- serving as the default and only supported interactive experience
- standing on its own against competing products

---

## Product Posture

The current product posture is:

- **default today**: native
- **competitive context**: external coding assistants are comparison targets, not runtime dependencies
- **owned delivery**: OwlCoda does not depend on a third-party branded frontend or CLI to define its product surface

## Distribution Posture

The current distribution posture is:

- **public distribution**: npm package + GPL public source tags
- **development source of truth**: private repo
- **public GitHub role**: corresponding source, docs/issues/releases, and public trust surface
- **release discipline**: every GPL-covered npm release must have a matching public source tag

Starting with the `0.15.0` license boundary, OwlCoda source is publicly
available under `GPL-3.0-or-later`. The private repo remains the day-to-day
development workspace, but it cannot substitute for the public corresponding
source required by a GPL-covered npm package.

Global install rule:

- Global `owlcoda` should mean the npm release installed from the registry.
- Local development builds should be run with `node dist/cli.js` or an isolated
  temporary prefix, not kept as the default global command.
- `owlcoda --version` is the first check for runtime identity; build metadata
  distinguishes a registry release from a local build.

---

## Native Promotion Rule

Native becomes the primary mode only when the following are true:

1. high-frequency coding workflow is stable end-to-end
2. must-have tool coverage is in place
3. session continuity and recovery are reliable
4. core differentiators are visible in native UX, not hidden behind proxy headers
5. remaining gaps are secondary surfaces rather than core daily workflow blockers

Native promotion is complete (R139):

- native is the default mode
- native is the only supported interactive path in the current product line

---

## L2 and L3 Truth

### L2 Skills

L2 is not future planning. It is a live product differentiator.

Its product value is:

- repeated work becomes more structured over time
- OwlCoda gets better through use
- the user gains visible local leverage unavailable in closed hosted tools

### L3 Training Data

L3 is also not just planning. The data pipeline exists today.

But the current product value of L3 is:

- data asset accumulation
- quality visibility
- future model leverage

It is **not** currently the main product loop.

Training and deployment closure depend on downstream platform readiness.
That downstream path should not distort OwlCoda's primary product priorities today.

---

## What OwlCoda Is Not

OwlCoda should not be described as:

- "just a front door"
- "just a proxy"
- "already fully independent from upstream"
- "primarily a model training product"

All four descriptions are incomplete or misleading.

---

## Documentation Authority

When documents disagree, use this order:

1. runtime truth from code and CLI behavior
2. this product truth document
3. README for user-facing positioning and onboarding
4. EVOLUTION for staged architectural direction
5. ROADMAP for historical delivery ledger and future sequencing

Version truth follows the same rule:

- runtime-reported version comes from [`package.json`](../package.json) via [`src/version.ts`](../src/version.ts)
- narrative release labels in docs or changelogs must not contradict runtime truth without explicitly saying so
- public user-facing install version follows the npm package version, and each
  GPL-covered package version must have a matching public source tag

---

## Immediate Documentation Consequences

The docs should consistently say:

- OwlCoda is an independent local AI coding platform
- native is the default mode (R139 切主完成)
- native is the only supported interactive path
- L2 is live differentiation
- L3 is live data accumulation, not current mainline training closure
- public distribution is npm package plus GPL public source tags
- the public repo is corresponding source, docs/issues/releases, and trust
  surface, not the day-to-day development source of truth
- global `owlcoda` should be the npm release; local builds stay explicit
