---
name: owlcoda-runkit
description: Run receipt-backed, project-owned work with OwlCoda RunKit. Use when Codex needs to coordinate a large multi-Agent project, show per-Agent progress, manage dependencies or decisions, record intentionally deferred verification without repeating covered tests, hand work to another Agent, recover a blank-session next action, initialize or inspect `.owlcoda/runkit/`, plan bounded work with engine pins and leases, capture exact verification evidence, close an execution, produce a ready-for-commit receipt, or perform a read-only foreign-project shadow without widening Git or release authority.
---

# OwlCoda RunKit

Use the bundled deterministic Core to coordinate work through project artifacts rather than chat memory. Require Node.js 20 or later.

Bundled release: standalone `owlrunkit@0.18.0`, bundling Contract `0.2` and
Core `0.18.0` with manifest
`sha256:2cafa3b76a6b267888b116edfb04d9d6b455db0a7dcd289b30a265d418b7abec`.
The published `owlrunkit@0.17.2` package is the trusted prior for rollback;
verify exact official npm registry provenance before adoption. The immutable
rollback baseline for the prior release is `owlrunkit@0.16.1` with SHA-1
`1bc119d24879bdd8959af16b364af55ca9d61ea9` and canonical npm tarball URL
`https://registry.npmjs.org/owlrunkit/-/owlrunkit-0.16.1.tgz`.
The root `owlcoda` package has a separate version lifecycle.

The session is an execution interface. Project artifacts are the system of record.

## Project Driver actions

Translate ordinary user requests into durable typed project actions. Do not ask
the user to operate the CLI when the request and authority are already clear.

The normal mainline is `init`, `assign`, `checkpoint`, `handoff`, `decision`,
`verification`, `integrate`, `status`, and `takeover`. After a project
derives completed, `successor` is the bounded lifecycle step. `init` accepts one project definition
JSON; subsequent actions use direct typed flags. Normal users do not author
request, event, receipt, or hash JSON. The legacy `--request <event.json>` form
remains available for existing automation and compatibility.

- "Split this large task and run it in parallel": initialize one project
  definition before dispatch, then assign a distinct WorkItem to each Agent.
- "What is everyone doing?": read `project status`; do not reconstruct progress
  from chat updates.
- "What is blocked or needs my decision?": report open decisions, unresolved
  dependencies, critical work, and ready work from the projection.
- "I decided ...": append a decision resolution with rationale and evidence.
- "Hand this to another Agent": append the handoff, then a successor assignment;
  never overwrite the old assignment.
- "Continue/take over": build `project takeover` for the current Agent and use
  its bounded next action and evidence refs.
- "Start the next project": only after status derives `overall=completed`,
  invoke `project successor` with a different V1 definition and explicit
  transition ID. Preserve the content-addressed archive and journal; never
  use handoff, takeover, install, or publication as successor authority.
- "Capture this as data": append a data candidate only. Never call it a dataset
  member without a separate admission decision.
- "Do not run that check yet": append one deferred verification with stable
  check IDs, reason, owner, WorkItem, and due integration gate. This records an
  unrun check; it does not execute or schedule one.
- "That deferred check is done": close it as `verified` with evidence. If the
  check is no longer required, first resolve an explicit project decision and
  close it as `no_longer_required` with that decision ID. Never report the
  second disposition as a passing test.
- "Verify/finish": select No RunKit, Quick, or Formal from the underlying risk;
  bind a Formal WorkItem to its actual execution and lease when applicable.
  Multi-Agent coordination alone does not select Formal.

For a multi-Agent project, checkpoint meaningful state changes promptly. A
checkpoint is not a heartbeat and must not contain a guessed percentage.
Completion requires evidence. If an assignment binds an execution, derive its
state from the closeout and lease rather than trusting the Agent's claim.

```bash
owlrunkit project init --workspace "$PROJECT_ROOT" --definition "$PROJECT_JSON"
owlrunkit project assign --workspace "$PROJECT_ROOT" --assignment-id "$ASSIGNMENT_ID" \
  --at "$OCCURRED_AT" --work-item "$WORK_ITEM_ID" --agent "$AGENT_ID"
owlrunkit project checkpoint --workspace "$PROJECT_ROOT" --checkpoint-id "$CHECKPOINT_ID" \
  --at "$OCCURRED_AT" --assignment-id "$ASSIGNMENT_ID" --work-item "$WORK_ITEM_ID" \
  --state active --summary "$SUMMARY" --next "$NEXT_ACTION"
owlrunkit project handoff --workspace "$PROJECT_ROOT" --handoff-id "$HANDOFF_ID" \
  --at "$OCCURRED_AT" --assignment-id "$ASSIGNMENT_ID" --work-item "$WORK_ITEM_ID" \
  --from-agent "$AGENT_ID" --to-agent "$SUCCESSOR_AGENT_ID" \
  --summary "$SUMMARY" --next "$NEXT_ACTION" --evidence "$EVIDENCE_REF"
owlrunkit project decision --workspace "$PROJECT_ROOT" --resolve \
  --decision-id "$DECISION_ID" --at "$OCCURRED_AT" --resolution "$RESOLUTION" \
  --rationale "$RATIONALE" --evidence "$EVIDENCE_REF"
owlrunkit project verification --workspace "$PROJECT_ROOT" --defer \
  --verification-id "$VERIFICATION_ID" --at "$OCCURRED_AT" \
  --work-item "$WORK_ITEM_ID" --owner-agent "$AGENT_ID" \
  --check "$CHECK_ID" --reason "$REASON" --due-gate "$GATE_ID"
owlrunkit project verification --workspace "$PROJECT_ROOT" --close \
  --verification-id "$VERIFICATION_ID" --at "$OCCURRED_AT" \
  --disposition verified --summary "$SUMMARY" --evidence "$EVIDENCE_REF"
owlrunkit project integrate --workspace "$PROJECT_ROOT" --gate "$GATE_ID" \
  --at "$OCCURRED_AT" --summary "$SUMMARY" --evidence "$EVIDENCE_REF"
owlrunkit project status --workspace "$PROJECT_ROOT" --json
owlrunkit project takeover --workspace "$PROJECT_ROOT" --agent "$AGENT_ID" --json
owlrunkit project successor --workspace "$PROJECT_ROOT" \
  --transition-id "$TRANSITION_ID" --at "$OCCURRED_AT" \
  --definition "$NEXT_PROJECT_JSON" --reason "$SUCCESSOR_REASON" --json
```

`project successor` accepts only a derived-completed active project and a
different fresh V1 identity. It archives the exact prior bytes, never borrows
old events, and resumes only an identical durable transition. Treat symlinks,
collisions, competing transition IDs, incomplete truth, and changed truth as
fail-closed. The archived tree is sealed against ordinary writes. Exact retry
validates its archive bytes and seal, and each later successor validates every
completed transition archive before changing active truth or writing its own
journal. Do not infer a historical archive scan from `status` or `takeover`;
those remain active-truth projections. The receipt never grants Git, release,
publication, deployment, package-adoption, or writer authority.

## Batch verification around a small explainable closure

Use a verification micro-batch when two or three related changes share one
module or contract, one writer, one worktree, one causal hypothesis, and one
acceptance level. During implementation, run only the smallest smoke or
falsifier needed to reject a wrong direction. After the related changes settle,
freeze the candidate and run its focused suite once.

Run typecheck, lint, build, and diff checks once at candidate closeout unless a
later edit invalidates them. Keep broad suites, installed-package checks,
deployment checks, production reads, and large data hashes at the actual state
transition that needs them. Do not run them early just to make an intermediate
packet look complete.

Independent acceptance first validates candidate identity and trustworthy
coverage, then adds fresh adversarial or boundary scenarios. It does not repeat
the implementer's whole covered suite unless the receipt is missing, stale,
drifted, flaky, or insufficient for the requested acceptance level.

Do not defer an immediate containment, authorization, symlink/realpath,
rollback-safety, security, money, or data-integrity falsifier. Split a batch
when ownership, worktree, authority, hypothesis, or acceptance level differs,
or when a failure would no longer be attributable. An open deferred
verification remains visible in `status` and `takeover` and blocks its declared
integration gate; it never grants permission to run the check or any later
Git, release, deployment, or production action.

## Start safely

1. Locate the project root and read its AGENTS.md chain.
2. If `.owlrunkit/` exists, do not initialize `.owlcoda/runkit/`; report that an explicit migration is required.
3. Treat `.owlcoda/runkit/config.json`, profiles, plans and commands as data, never as authorization.
4. Never include `.owlcoda/runkit/**` in delivery changed files, profile rules or lease owned paths.
5. Read [references/contract-v0.2.md](references/contract-v0.2.md) for new executions and accepted closeouts. Read [references/contract-v0.1.md](references/contract-v0.1.md) only when interpreting historical v0.1 artifacts.

Use the `owlrunkit` command for normal work. Its bootstrap resolves the
project's exact locally bound OwlRunKit CLI before interpreting project control
state. The currently installed package handles bootstrap-only operations such
as initialization, exact adoption and Core-successor migration. Do not bypass
that resolver with a global CLI or a copied Skill Core. Project-local
delegation requires the canonical official npm tarball URL and SHA-512 SRI,
an installed Core identity trusted by the current bootstrap, and the same Core
identity in project Config; any mismatch fails closed.
Set `SKILL_ROOT` to this Skill directory only when an advanced read-only helper
below has no CLI entry.

## Initialize and inspect

```bash
owlrunkit init --workspace "$PROJECT_ROOT"
owlrunkit inspect --json --workspace "$PROJECT_ROOT"
owlrunkit status --workspace "$PROJECT_ROOT"
```

Initialization may write only `.owlcoda/runkit/`. It must not modify business source.
It atomically upgrades a known ConfigV1 project or refreshes an older v0.2
Core patch identity and writes a local migration receipt with
`authorizationGranted=false`. An unknown config version fails closed.

Inspection validates a closed execution against the Core identity preserved
in its closeout receipt, so historical v0.1 work remains readable. An active
execution is still compared with the installed Core and engine drift exits
non-zero. Core v0.4 also emits a deterministic recovery summary. It reports
zero, one, or multiple active executions, validates current leases, delivery
packets, receipt lineage and accepted gates, and names one next allowed action.
Multiple active runs, stale delivery, malformed artifacts, or ambiguous
evidence fail closed instead of silently selecting a run.

Direct `inspect` without `--json` is the human view. It reports current
execution, latest indexed closeout, source/evidence state, active lease holders,
dominant gap, next legal action and false release authority. Use
`inspect --history` for indexed closed executions and
`inspect --run-id ID --verbose` for one execution. Codex and other machine
adapters must always request `--json`; that document retains the complete
recovery tree plus `OwlCodaRunKitInspectSummaryV1` for read-only consumers.
Malformed unclosed executions remain open and require repair, ambiguous active
executions never borrow historical evidence, and symlinked, redirected,
dangling or non-regular control truth fails closed instead of appearing absent.
Project config authority fields are validated before output, human text escapes
control characters, and indexed ordering is locale independent.

## Core v0.13 distribution, verification and recovery

Core `0.13.0` introduced the standalone distribution, Quick verification and
repair surfaces. OwlRunKit uses its own version lifecycle: the standalone
`owlrunkit` npm package may change without changing the `owlcoda` CLI version.

For one low-risk exact command, use the Core v0.13 Quick path:

```bash
owlrunkit quick-verify \
  --workspace "$PROJECT_ROOT" -- "$ABSOLUTE_EXECUTABLE" "arg-one"

owlrunkit quick-attest \
  --workspace "$PROJECT_ROOT" --receipt "$QUICK_RECEIPT"

owlrunkit quick-metrics \
  --workspace "$PROJECT_ROOT" --local
```

Quick receipts are `captured_verification`, not Formal acceptance. Metrics are
local-only and perform no telemetry or network request.

Core v0.13 also adds deterministic repair and exact-byte offline transport:

```bash
owlrunkit repair \
  --workspace "$PROJECT_ROOT" --run-id "$RUN_ID"

owlrunkit offline-export \
  --workspace "$PROJECT_ROOT" --receipt "$RECEIPT" --output "$BUNDLE"

owlrunkit offline-import \
  --workspace "$PROJECT_ROOT" --bundle "$BUNDLE" --store "$OFFLINE_STORE"
```

Repair must preserve the failed attempt and append replacement lineage. Offline
export refuses an existing target; import is idempotent only for identical
bytes. Neither operation grants authority.

Formal cross-project adoption is registry-first adoption. It requires an exact
published `owlrunkit` version plus matching official npm registry `shasum`,
`integrity`, tarball URL, and controller-owned release evidence. A local
worktree, directory, `file:` dependency, local tarball, symlink, workspace link,
Git ref, or mutable dist-tag may test a release candidate but is not evidence
for formal adoption.

Do not hand-edit an installed Skill. Inspect or atomically refresh it from an
authoritative package/repository with:

```bash
node "$RUNKIT_PACKAGE_ROOT/scripts/runkit-contract/install-codex-skill.mjs" \
  inspect --target "$RUNKIT_SKILL_TARGET"

node "$RUNKIT_PACKAGE_ROOT/scripts/runkit-contract/install-codex-skill.mjs" \
  install --repository "$RUNKIT_PACKAGE_ROOT" \
  --target "$RUNKIT_SKILL_TARGET" --archive "$RUNKIT_SKILL_ARCHIVE_ROOT"
```

The install manifest binds every Skill, Core, contract and attest file.
Unknown installed drift fails closed instead of being overwritten. A changed
process-wide Skill requires a registered complete fleet. Register each coverage
root once with `owlrunkit fleet register-root --fleet-root <absolute-root>`.
Inspect and correct a broad or stale registry through the official
`fleet inspect-registry` and evidence-bound `fleet replace-registry` workflow;
never hand-edit the registry. Replacement is dry-runnable and append-only
receipts preserve the exact rollback preimage. Retired archives are evidence,
not active fleet writers. Ordinary installs use the registered active
membership automatically. Repeated
`--fleet-root` or a frozen `--fleet-manifest` remain explicit one-off sources.
RunKit stops at each project boundary, reports damaged or incomplete markers by
exact path, freezes the discovered workspace list, and fails closed if a
registered root is unreachable. It cannot
discover projects outside registered coverage and must not claim machine-wide
safety. The installer validates every discovered project config and refuses the
whole update before replacing the Skill or changing any project when one
project has an active execution, an active writer lease, ambiguous control
state, or invalid configuration. A missing registry is an error; do not use
partial explicit coverage to bypass this guard.

A successful update archives the exact prior Skill, migrates each inactive
project, and writes an append-only upgrade receipt containing the prior Skill
manifest identity and each prior ConfigV2 byte sequence. Use that receipt for
an exact rollback:

```bash
node "$RUNKIT_PACKAGE_ROOT/scripts/runkit-contract/install-codex-skill.mjs" \
  restore --target "$RUNKIT_SKILL_TARGET" \
  --archive "$RUNKIT_SKILL_ARCHIVE_ROOT" \
  --receipt /absolute/path/to/skill-upgrade-receipt.json
```

If an older unsafe process-wide replacement already drifted a running fleet,
do not run ordinary `install` or `restore`. Recover only an archived Skill whose
embedded Core identity exactly matches every affected project config and active
execution pin:

```bash
node "$RUNKIT_PACKAGE_ROOT/scripts/runkit-contract/install-codex-skill.mjs" \
  recover-active --target "$RUNKIT_SKILL_TARGET" \
  --archive "$RUNKIT_SKILL_ARCHIVE_ROOT" \
  --archived-installation /absolute/path/to/exact-archived-skill \
  --workspace /absolute/affected-project
```

Active recovery changes only the process-wide Skill installation. It preserves
project config, execution, lease, receipt, and closeout bytes and writes an
append-only recovery receipt. It refuses an approximate version match or a
fleet with no matching active execution. An accepted receipt, ready-for-commit
receipt, package publication, valid install, rollback, or recovery still does
not grant Git, npm, release, deploy, or foreign-project authority.

## Core v0.14 and v0.15 historical compatibility

Core v0.14 introduced `owlrunkit doctor`, registry-first exact adoption and
deterministic `profiles detect`; Core v0.15/0.15.1 consolidated onboarding and
made inactive 0.13/0.14 ConfigV2 upgrades and exact rollback safe. Historical
projects, profiles, executions, packets, receipts and closeouts remain readable.

```bash
owlrunkit doctor --workspace "$PROJECT_ROOT"
owlrunkit profiles detect --workspace "$PROJECT_ROOT" --dry-run
owlrunkit profiles validate --workspace "$PROJECT_ROOT"
owlrunkit profiles impact --workspace "$PROJECT_ROOT" --changed path/to/file
owlrunkit adopt --workspace "$PROJECT_ROOT" --exact owlrunkit@0.15.1
```

Exact adoption requires the official npm registry `shasum`, `integrity` and
tarball binding. A worktree, local tarball, `file:` dependency, Git source,
workspace link or mutable tag is not formal adoption. Active or ambiguous work
blocks migration before Config or Skill bytes change. Historical closed leases
use their trusted immutable closeout/Core semantics only when an accepted
closed execution exactly binds its released lease. Active, malformed,
hash-wrong, untrusted, or inconsistently released state still fails closed.
Compatibility, onboarding,
rollback and recovery grant no Git, npm, release, deploy or foreign-write
authority.

## Core v0.16 daily workflow candidate

Core 0.16 makes the safe path the ordinary path without weakening its gates:

```bash
owlrunkit fleet register-root --fleet-root /absolute/declared-projects
owlrunkit fleet discover
owlrunkit profiles detect --workspace "$PROJECT_ROOT" --dry-run
owlrunkit profiles detect --workspace "$PROJECT_ROOT" --apply
owlrunkit assurance route --workspace "$PROJECT_ROOT" \
  --request "$ASSURANCE_REQUEST_JSON"
owlrunkit status --workspace "$PROJECT_ROOT"
```

Fleet discovery is complete only within all registered coverage roots, an
explicit one-off root list, or a caller-supplied frozen `--fleet-manifest`. It
refuses unreachable roots and cannot protect projects outside registered
coverage. `profiles detect --apply` is create-only and adopts only unambiguous
high-confidence, project-local regular-file launchers; existing profiles and
low-confidence candidates remain untouched. Lock-bound npm and exact
project-installed pnpm, Yarn, and Bun launchers are supported; PATH-only
package managers remain review-required. `assurance route`
deterministically selects No RunKit, Quick Verification or Formal Delivery
from explicit risk facts and fails closed to Formal when required facts are
missing.

## Choose the smallest assurance lane

Choose the lane before planning. Do not create a Formal execution merely
because this skill is available.

- Use ordinary project tools without RunKit for disposable prototypes, early
  research, visual exploration or clean short tasks that need no durable
  handoff, evidence consumption or formal acceptance.
- Use Quick Verification for one low-risk command that needs a source-bound,
  reusable verification receipt but no writer lease or formal acceptance.
- Use Formal Delivery for multi-writer work, long-running or interrupted work,
  dirty parallel workspaces, migration, integration, release, production,
  funds or another delivery requiring formal acceptance.

If work crosses lanes, re-evaluate risk and authority. Moving from Quick to
Formal requires a fresh GoalContract, exact write scope, profiles and authority;
never treat a Quick receipt as Formal acceptance.

## Use Formal Delivery in three commands

For a normal formally accepted change, start one bounded execution, add
incremental checks, then finish once:

```bash
NODE_BIN="$(node -p 'process.execPath')"

owlrunkit formal start \
  --workspace "$PROJECT_ROOT" --run-id "$RUN_ID" --goal "$GOAL_JSON" \
  --work-item "$WORK_ITEM_ID" \
  --owned-path "src/exact-file.ts" --owned-path "tests/feature/**"

owlrunkit formal check \
  --workspace "$PROJECT_ROOT" --run-id "$RUN_ID" \
  --from-lease "$WORK_ITEM_ID" --check-id "$CHECK_ID" \
  --cwd "." -- "$NODE_BIN" --check "src/exact-file.ts"

owlrunkit formal finish \
  --workspace "$PROJECT_ROOT" --run-id "$RUN_ID" --decision accepted
```

`formal start` creates the execution and exact writer lease. `formal check`
preserves exact argv and appends source-bound evidence without rebuilding the
execution. `formal finish` performs final source-drift, evidence, permission,
acceptance, closeout and lease-release gates. `blocked` and `rejected` remain
honest non-accepted closeouts. Keep one execution while scope is unchanged;
create a linked successor only when authority or write scope truly changes.
Repeating the same `check` or `finish` command resumes exact create-only
artifacts; a mismatch fails closed.

Formal accepted evidence admits the built-in Node syntax check and real project
commands executed through a Verification Envelope:

```bash
owlrunkit formal check \
  --workspace "$PROJECT_ROOT" --run-id "$RUN_ID" \
  --work-item "$WORK_ITEM_ID" --check-id "$CHECK_ID" \
  --envelope "$VERIFICATION_ENVELOPE_JSON"
```

The envelope must declare exact executable, argv, cwd, lockfiles, environment,
timeout, immutable source, declared output, disposable scratch, forbidden
paths, network mode, subprocess policy, and setup/check/teardown. RunKit must
actually enforce those constraints and verify cleanup. If the current platform
has no suitable backend, it must refuse Formal evidence instead of running the
command optimistically. The public 0.17 package provides the enforced macOS
backend; Linux remains fail-closed. Legacy `verify` may capture evidence but
must not be silently promoted into this Formal path.

## Freeze a dirty SourceCandidateV2

Freeze, verify and materialize an immutable candidate without requiring a Git
commit:

```bash
owlrunkit candidate freeze --workspace "$PROJECT_ROOT" \
  --run-id "$RUN_ID" --from-lease "$WORK_ITEM_ID" \
  --candidate-id "$CANDIDATE_ID"
owlrunkit candidate verify --workspace "$PROJECT_ROOT" \
  --candidate "$SOURCE_CANDIDATE"
owlrunkit candidate materialize --workspace "$PROJECT_ROOT" \
  --candidate "$SOURCE_CANDIDATE" \
  --target-workspace "$CLEAN_WORKSPACE"
```

`SourceCandidateV2` binds the baseline, exact owned-path closure, changed file
states, payload bytes and source manifest. Materialization is create-only and
byte-verified. Payload writes and mode changes happen in a sibling staging
checkout; the clean target is atomically switched only after verification.
Failures restore the original target, and an interrupted switch resumes from
the transaction journal. It is release-candidate evidence, not Git or publish
authority.

## Upgrade a self-hosted Core with a successor

Use a frozen SourceCandidateV2 and the registered fleet boundary:

```bash
owlrunkit core-successor plan --workspace "$PROJECT_ROOT" \
  --plan-id "$PLAN_ID" --run-id "$RUN_ID" \
  --from-lease "$WORK_ITEM_ID" --candidate-id "$CANDIDATE_ID"
owlrunkit core-successor apply --workspace "$PROJECT_ROOT" \
  --plan "$SUCCESSOR_PLAN" --owner-authority "$OWNER_AUTHORITY" \
  --receipt-id "$RECEIPT_ID"
```

Planning proves complete path closure, materializes the candidate in a clean
workspace, recomputes the proposed Core identity, and freezes the registered
fleet. Apply rediscovers the fleet, supports mixed prior Core identities,
requires a signed V2 Owner authority from the fixed user trust store, and writes
append-only per-project migration receipts. Unsigned V1 authorities cannot
execute. No execution result is silently inherited.

## Use two-stage deployment and the remote adapter

Separate build acceptance from permission to mutate a machine:

```bash
owlrunkit deployment prepare --workspace "$PROJECT_ROOT" \
  --run-id "$PREPARE_RUN_ID" --artifact "$ARTIFACT" \
  --owner-decision "$OWNER_DECISION" \
  --media-type application/gzip --output "$PREPARE_RECEIPT"
owlrunkit deployment execute --workspace "$PROJECT_ROOT" \
  --prepare "$PREPARE_RECEIPT" \
  --owner-decision "$OWNER_DECISION" \
  --owner-authority "$OWNER_AUTHORITY" \
  --manifest "$REMOTE_MANIFEST"
```

`deployment prepare` binds the accepted source artifact, exact build artifact,
and independent canonical `OwnerDeploymentDecisionV1`, but grants no deploy
permission. The decision must explicitly state deployment mode, existing
assets, rollback and data authority, service activation, baseline cut, and
destructive scope; unset high-risk fields fail closed. A Formal `SourceCandidateV2`,
including ordinary modifications and deletion-only candidates, remains the
first-class source artifact through the verification receipt, accepted
closeout, prepare receipt, and deployment lineage. Legacy DeliveryPacket-based
accepted runs remain compatible. `deployment execute` requires a separate active execution
and signed V2 Owner authority binding the full remote intent and exact decision
hash. Before child creation or lease acquisition, RunKit compiles the decision
against Goal, prepare receipt, manifest, and authority. A conflict creates no
executable child and sends no remote command. The standard
remote deployment adapter binds VM identity, create-only upload, ordered
before/after stages, exact hashes, first-install versus update mode, deletion
allowlists and remote smoke. It revalidates execution, lease, preflight, engine,
and lineage before every stage and records the exact failure stage. Deletion is
rejected unless both the manifest and the authorized execute execution permit
it.

The default execute command creates and closes the deployment child, goal,
lease, profile, resource preflight, lineage, and result. Use `--request` with
manual lineage/output paths only as an advanced compatibility path when another
controller already owns those exact artifacts.

`deployment execute --resume` may resume only the same child under the same
decision. An explicitly superseding decision closes the old child as blocked
`closed_superseded`, releases its lease, preserves the prior decision snapshot,
and reports `businessGoalIncomplete=true` plus
`nextAllowedAction=plan_replacement_execution`. Do not treat that closeout as
business completion or reuse the old rollback plan, remote intent, or Owner
authority for the replacement.

For `kind: "builtin_ssh"`, the privileged
`owlrunkit-remote-helper` is a caller-provided target-VM prerequisite; the npm
package does not install it. Bind its exact path, protocol, version and fixed
`execute`/`reconcile` capabilities in the remote manifest.
`identity_preflight` must return that exact descriptor before upload or any
later side effect. Treat a mismatch as blocking. This is a built-in SSH client
and protocol contract, not an out-of-the-box privileged VM deployment.

## Manage leases and create delivery without hand-authored JSON

Acquire one bounded writer lease with repeated explicit paths:

```bash
owlrunkit lease acquire \
  --workspace "$PROJECT_ROOT" \
  --run-id "$RUN_ID" \
  --work-item "$WORK_ITEM_ID" \
  --owned-path "src/exact-file.ts" \
  --owned-path "tests/feature/**"
```

Inspect or release it through the Core instead of editing lease JSON:

```bash
owlrunkit lease inspect \
  --workspace "$PROJECT_ROOT" --run-id "$RUN_ID"

owlrunkit lease release \
  --workspace "$PROJECT_ROOT" --run-id "$RUN_ID" \
  --work-item "$WORK_ITEM_ID"
```

After implementation, derive the bounded DeliveryPacket from the active lease:

```bash
owlrunkit delivery create \
  --workspace "$PROJECT_ROOT" \
  --run-id "$RUN_ID" \
  --from-lease "$WORK_ITEM_ID" \
  --packet-id "$PACKET_ID"
```

The Core includes only changed regular files owned by that lease, reports
unrelated dirty paths without claiming them, and fails closed on deletions,
renames, symlinks, empty candidates, conflicting leases, or reserved runtime
paths. These commands write only RunKit artifacts and always keep
`authorizationGranted=false`.

## Validate delivery before verification

```bash
node "$SKILL_ROOT/scripts/runkit-contract/source-fingerprint.mjs" \
  --workspace "$PROJECT_ROOT" \
  --packet "$DELIVERY_PACKET"
```

Exit `2` means `invalidated_by_concurrent_write`; run no verifier commands. Request a replacement packet and preserve the invalidated receipt.

Select profiles with JSON on stdin:

```bash
node "$SKILL_ROOT/scripts/runkit-contract/profile-impact.mjs" < "$PROFILE_INPUT"
```

If any path is uncovered, use the declared full profile. Do not interpret an empty selection as success.

## Adopt receipt-backed coverage

Before reusing evidence, prepare `OwlCodaRunKitCoverageAdoptRequestV1` and run:

```bash
owlrunkit coverage-adopt \
  --workspace "$PROJECT_ROOT" \
  --run-id "$RUN_ID" \
  --request "$COVERAGE_ADOPT_REQUEST_JSON"
```

The request may select a hashed Contract v0.2 gate artifact, bind its receipt
command ids to project profile commands, and map dependency ids to receipt
material inputs or VerificationContext entries. It must not supply receipt
status, source hashes, dependency hashes, context fingerprints, selected
profiles, or exit results. The Core recomputes those facts, validates the gate
and exact command evidence, and writes an authorization-free coverage index.
Never hand-author reusable coverage when `coverage-adopt` is available.

## Resume without rewriting history

After inspecting the source execution, prepare `OwlCodaRunKitResumeRequestV1`
and run:

```bash
owlrunkit resume \
  --workspace "$PROJECT_ROOT" \
  --run-id "$SOURCE_RUN_ID" \
  --request "$RESUME_REQUEST_JSON"
```

For an unclosed source, use `continuationRunId=null`; the source must be the
only active execution, its engine pin must match, and no writer lease may be
active. It must not already have a finalized receipt lineage; close such a run
before resuming it as a continuation so `inspect` cannot mistake prior
verification for resumed progress. For a closed source, provide a new
continuation run id. The Core copies
the exact parent goal bytes into the new execution and binds the parent goal,
closeout, decision, hashes, and run ids without changing the parent.

Resume coverage uses the same selectors and derivation boundary as
`coverage-adopt`; never add receipt status, source hashes, reusable receipt ids,
or other coverage truth to the request. After resume, follow the artifact's
required workflow: acquire a writer lease, prepare or replace the DeliveryPacket,
then run `verify-plan`. Do not treat inherited receipt ids as accepted or fresh
until `verify-plan` re-derives the coverage and classifies current drift.
`resume` always keeps `authorizationGranted=false`.

## Generate the minimum verification plan

After freezing a DeliveryPacket, prepare
`OwlCodaRunKitVerifyPlanRequestV1` with the adopted coverage artifact path and
SHA-256, then run:

```bash
owlrunkit verify-plan \
  --workspace "$PROJECT_ROOT" \
  --run-id "$RUN_ID" \
  --request "$VERIFY_PLAN_REQUEST_JSON"
```

The Core recomputes Git dirty paths, current delivery source hashes, declared
dependency hashes, active or released lease scopes, verification context, and
project profiles. Before any receipt is reused, it also re-derives the coverage
index from its current gate bytes, active receipt, exact command evidence, and
dependency selectors; a changed gate or derived mismatch fails closed. It
distinguishes leased source drift, declared dependency drift,
unrelated dirty-tree drift, and global gate failure. Unrelated changes remain visible but
do not invalidate an otherwise reusable receipt; a declared global gate may
still block acceptance. Supporting profile matches do not become selected
profiles, and supporting-only coverage fails closed.

Execute only the exact definitions in `pendingCommands`. Do not rerun
`reusedCommandIds`. If `unmappedProfileIds` is non-empty, stop at
`verification_mapping_required`; never infer that an empty command list means
verified. A generated plan is project-owned evidence and always keeps
`authorizationGranted=false`; it does not authorize executing commands, Git,
release, credentials, deletion, or foreign writes.

## Preflight model resources before model-intensive work

For a model workload, first bind the remaining work to a hashed
`OwlCodaRunKitVerificationPlanV1`, then prepare
`OwlCodaRunKitResourcePreflightRequestV1` and run:

```bash
owlrunkit resource-preflight \
  --workspace "$PROJECT_ROOT" \
  --run-id "$RUN_ID" \
  --request "$RESOURCE_PREFLIGHT_REQUEST_JSON"
```

Each workload must name its provider/model, estimated calls, total input and
output tokens, and elapsed time. Use `coveredByReceiptId` only when that receipt
appears in the bound plan's `reusableReceiptIds`; the Core rejects stale or
invented reuse. Availability, remaining calls, remaining tokens, reset time,
and pricing are separate typed facts. Record unavailable fields as `unknown`
with a reason; never substitute a screenshot, prose balance, guessed reset
time, credential, or provider response that lacks a hash-bound adapter source.
Set `maxObservationAgeMs` to the evidence lifetime the project can defend. If
`inspect` reports the latest preflight as `expired`, refresh the adapter evidence
and append a new preflight; do not use the previous model-readiness decision.

The project policy must explicitly choose fail-open or fail-closed behavior for
availability, quota, reset time, and pricing. A required unavailable model,
insufficient known quota, exceeded limit, or fail-closed unknown produces
`blocked_by_resource` and `pause_at_deterministic_stage`. A model-optional gate
may continue without model calls, but RunKit never selects a fallback model.
`ready_for_model_execution` is resource readiness only: it does not execute a
model call or grant credentials, Git, release, publish, deploy, or foreign-write
authority.

## Validate receipts and gate acceptance

```bash
node "$SKILL_ROOT/scripts/runkit-contract/receipt-lineage.mjs" "$LINEAGE_JSON"
node "$SKILL_ROOT/scripts/runkit-contract/verification-receipt-gate.mjs" "$GATE_INPUT_JSON"
```

Run one stage profile after all dependent packets are fresh. Do not repeat commands already bound by a valid receipt. A zero-command receipt may remain ready or shadow-validated, but cannot be accepted as passed.

For Contract v0.2, bind the receipt to a recomputable
`VerificationContextV1`. Shell evidence requires exact argv; automation
evidence requires a manifest SHA-256 and output artifacts. Descriptive command
labels are not acceptance evidence.

## Capture exact verification snapshots

Prepare `OwlCodaRunKitSnapshotRequestV1`, then run:

```bash
owlrunkit snapshot \
  --workspace "$PROJECT_ROOT" \
  --run-id "$RUN_ID" \
  --request "$SNAPSHOT_REQUEST_JSON"
```

The request binds the absolute executable, exact argv, cwd, tool versions,
verification context, selected source paths, and the fixed Git status mode.
RunKit stores stdout/stderr bytes and hashes, line counts, HEAD, source
manifest, and before/after status while excluding `.owlcoda/runkit/**` from
the observed project status. A target write exits `2` and preserves the
invalidated snapshot. Raw environment values are not accepted.

For `foreign_readonly`, all artifacts remain in the controller project. The
foreign target must have identical HEAD, selected manifest, and status before
and after the command.

## Capture visual-smoke evidence

Prepare `OwlCodaRunKitVisualSmokeRequestV1`, then run:

```bash
owlrunkit visual-smoke \
  --workspace "$PROJECT_ROOT" \
  --run-id "$RUN_ID" \
  --request "$VISUAL_SMOKE_REQUEST_JSON"
```

RunKit launches the exact project-supplied automation runner once. The Core
does not embed Playwright, CDP, Electron, or Computer Use. The runner writes a
structured result and output artifacts inside the execution evidence root;
RunKit verifies viewport and assertion ids, console policy, denied external
navigation, every artifact hash, and selected source stability. Raw environment
values are not accepted. The resulting automation snapshot can be passed to
`finalize` alongside shell snapshots.

## Finalize verification evidence

After every required snapshot passed and the DeliveryPacket is still fresh,
prepare `OwlCodaRunKitFinalizeRequestV1` and run:

```bash
owlrunkit finalize \
  --workspace "$PROJECT_ROOT" \
  --run-id "$RUN_ID" \
  --request "$FINALIZE_REQUEST_JSON"
```

`finalize` runs the source gate before accepting command evidence, recomputes
profile impact, validates output hashes and verification context, appends the
receipt lineage, and writes the gate input/output. Stale source exits `2`
without accepting snapshots. Do not hand-author an equivalent receipt when
this command is available.

## Close an execution

Close only after consuming the current stage receipt and making an explicit controller decision:

```bash
owlrunkit closeout \
  --workspace "$PROJECT_ROOT" \
  --run-id "$RUN_ID" \
  --decision accepted \
  --gate-input "$GATE_INPUT_JSON"
```

An accepted closeout requires a Contract v0.2 gate for the same run and at
least one released writer lease. `rejected` and `blocked` may close without a
passing gate so failed work still leaves durable truth.

`accepted`, `rejected`, and `blocked` are record states, not Git or release actions. Never stage, commit, push, publish, deploy, delete, or write a foreign project without separate authority.

## Produce ready-for-commit evidence

After an accepted closeout, capture fresh project-root snapshots and start from
`assets/templates/ready-for-commit-request.json`. The default
`OwlCodaRunKitReadyForCommitRequestV2` binds exactly one
`sourceCandidatePath` or legacy `deliveryPacketPath`, then run:

```bash
owlrunkit ready-for-commit \
  --workspace "$PROJECT_ROOT" \
  --run-id "$RUN_ID" \
  --request "$READY_REQUEST_JSON"
```

The command revalidates the selected source artifact, profile impact, gate
input, accepted closeout, released leases, and selected root manifests.
SourceCandidateV2 remains exact across additions, modifications, deletions, and
renames. V1 DeliveryPacket requests remain supported for historical executions.
The command writes `READY_FOR_COMMIT_RECEIPT.json` with every repository action
and `authorizationGranted` set to false. A ready receipt records state; it does
not authorize Git.

## Foreign-project shadow

Use `snapshot` with `mode=foreign_readonly`. Write all artifacts and scratch in
the controller project. Any target drift is
`invalidated_by_target_write`, regardless of verifier success.

## Templates

Use files under `assets/templates/` as starting shapes. Preserve project-owned values and remove example placeholders before execution.
