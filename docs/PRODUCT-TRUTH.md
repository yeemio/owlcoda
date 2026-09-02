# OwlCoda Product Truth

> Last updated: 2026-09-02
> Scope: public product identity, current release truth, architecture boundaries,
> and distribution authority

## Identity

OwlCoda is being built as a local-first **AI Business Execution System**.

Its durable product identity is not a particular model, coding agent, CLI, or
executor session. OwlCoda owns the business semantics and bounded causal
transaction envelope that turns admitted evidence into a reviewable business
result while keeping external action behind a separate authority gate.

The compact product statement is:

> **OwlCoda binds evidence, replaceable execution, admitted results, human
> review, and explicit authority boundaries without surrendering Business
> Truth to an executor.**

## Business execution spine

The intended architecture keeps every promotion explicit:

```text
point-in-time Evidence
  -> Evidence Admission
  -> WorkCase
  -> Execution Admission
  -> Execution
  -> Attempt
  -> replaceable Executor
  -> Result Candidate
  -> Result Admission
  -> WorkResult
  -> Qualification
  -> Human Adjudication
  -/-> BusinessAction (separate authority required)
```

Evidence intake, execution, result commitment, qualification, human review,
and BusinessAction are different states. Passing one state never silently
promotes another.

## Current public release truth

The current public npm and source release is **`owlcoda@0.18.0`**.

That release is the local runtime and harness foundation of the broader product
direction. It publicly provides the native terminal workbench, local and cloud
model routing, tools, session persistence, learned skills, opt-in local training
data collection, browser administration, diagnostics, structured-output routes,
and execution artifacts described by the release code and capability registry.

It does **not** claim that the full Business Execution System is present in the
0.18.0 public package. In particular, this repository does not claim public
production connectors, multi-tenant business storage, autonomous
BusinessAction, commercial readiness, or deployment to a customer environment.

Product direction is not release truth. A future architecture document or a
private implementation candidate cannot be presented as a shipped public
capability until it has its own source, package, runtime, and acceptance
evidence.

## Product-family boundaries

### OwlCoda

Owns the governed business-execution architecture, Business Truth, business
semantic versions, admission and qualification boundaries, human review, and
the separation between an accepted result and an authorized action.

The current public 0.18.0 package owns the local Runtime/Harness foundation. It
does not pretend that foundation alone is the complete business product.

### OwlRunKit

[OwlRunKit](https://github.com/yeemio/owlrunkit) owns delivery continuity:
Project/WorkItem/Assignment state, candidate identity, verification receipts,
handoff, rework, recovery, and explicit delivery lifecycle projections.

OwlRunKit does not own WorkCase, Business Truth, Attempt or Session identity,
domain judgment, or BusinessAction. Its authority boundary remains false for
Git, release, deployment, production, automation, money, and business actions.

### Executors

Models, local runtimes, coding agents, and executor adapters are replaceable.
They may produce a Result Candidate, but they do not define the product, admit
their own result into Business Truth, or authorize the downstream business
action.

## Local-first and privacy posture

The public runtime is local-first:

- sessions and project artifacts remain on the user's machine by default;
- OwlCoda requires no OwlCoda account or hosted OwlCoda service;
- users choose and configure their own local or cloud model endpoints;
- training-data collection is opt-in, local, and PII-sanitized before storage;
- new telemetry, external collection, or privacy-sensitive egress must be
  opt-in, documented, and disable-able.

Local-first does not mean that a user-selected cloud model receives no data. A
configured provider receives the prompts and inputs the user sends to that
provider under its own terms.

## Distribution posture

- **public npm package:** executable release surface;
- **public GitHub repository:** corresponding source, documentation, Issues,
  Releases, and public trust surface;
- **private source repository:** day-to-day development source of truth;
- **public source tag:** required for every GPL-covered npm release;
- **website and marketplaces:** discovery surfaces, not source or release
  authority.

Starting with the 0.15.0 license boundary, OwlCoda source is distributed under
`GPL-3.0-or-later`. The private development repository cannot substitute for
public corresponding source.

Global `owlcoda` should mean an official npm release. Local development builds
must remain explicit and must not masquerade as registry release truth.

## What OwlCoda must not claim

Do not describe OwlCoda as:

- only a proxy, wrapper, or front door;
- already shipping every capability in the long-term business architecture;
- a product defined by one model, vendor, CLI, or executor session;
- a system where a green test or accepted candidate grants deployment or
  business authority;
- already production-deployed, commercially ready, or business-accepted
  without direct evidence for that state.

## Documentation authority

When public documents disagree, use this order:

1. fresh runtime and registry truth for the installed release;
2. tagged source and machine-readable capability identity;
3. this product-truth document;
4. README for user-facing positioning and onboarding;
5. architecture and roadmap documents for staged direction.

Version truth comes from `package.json` and the runtime version surface. Public
release truth additionally requires the matching npm provenance and public
source tag. Narrative labels never override those identities.
