# Status matrix: legacy runtime tools (issue #4)

Round: 0.1.4 public security release, sourced from private 0.13.21, 2026-04-26.
Result: **legacy / not reachable from production. Bridged for safety.**

## Surface → tool implementation matrix

| Surface | Production? | Bash impl | Read impl | Write impl | Glob impl | Bash risk classifier | FS policy |
|---|---|---|---|---|---|---|---|
| `dist/cli.js` (npm bin) | ✅ | `src/native/tools/bash.ts` | `src/native/tools/read.ts` | `src/native/tools/write.ts` | `src/native/tools/glob.ts` | `src/native/bash-risk.ts` (via `headless-approval` + tui permission) | `src/native/tools/fs-policy.ts` |
| `src/native/repl.ts` (interactive REPL) | ✅ | same as above | same | same | same | same | same |
| `src/native/headless.ts` (`owlcoda run --prompt`) | ✅ | same as above | same | same | same | **same — gated** | same |
| `src/server.ts` (`/v1/messages` proxy) | ✅ | does not execute tools (proxies to LLM) | n/a | n/a | n/a | n/a | n/a |
| `src/frontend/repl.ts` (legacy source-first REPL) | ❌ legacy, not bound to any CLI command | `src/runtime/tools.ts` | `src/runtime/tools.ts` | `src/runtime/tools.ts` | `src/runtime/tools.ts` | **bridged** to `src/native/bash-risk.ts` via `isDangerousBash` | none — uses its own `isWithinWorkspace` (unchanged from pre-P0) |
| `src/runtime/tools.ts` (legacy runtime) | ❌ only consumer is `src/frontend/repl.ts`, which is itself legacy | spawns `bash -c` directly | direct fs | direct fs | direct fs | **bridged** | own `isWithinWorkspace` |

## Why "legacy" rather than "deleted"

- The file ships in `dist/` and has live tests (`tests/tools.test.ts`) — deleting it in this round would have churn beyond the security scope.
- It is preserved as a reference implementation of the pre-native source-first REPL contract.
- It now delegates bash danger classification to `classifyBashCommand`, so even if a future caller revives it, bash risk policy stays consistent with the native dispatcher (bridge complete).
- Filesystem path policy in the legacy runtime is **not** bridged. The legacy `executeWrite` uses its own `isWithinWorkspace` boundary (cwd-prefix match, no realpath, no sensitive denylist). This is documented as a known divergence; it does NOT affect production because `src/frontend/repl.ts` has no production consumer.

## Boundary enforcement

`tests/runtime-tools-boundary.test.ts` fails if:
1. Any file under `src/` (other than the explicitly-allowed `src/frontend/repl.ts`) imports from `src/runtime/tools.ts` or `src/frontend/repl.ts`.
2. Any of the production seed files (`src/cli.ts`, `src/cli-core.ts`, `src/server.ts`) directly imports `runtime/*` or `frontend/repl`.
3. The legacy bash danger classifier no longer routes through the native bash-risk classifier.

Loosening the boundary requires updating this matrix in the same commit.

## Follow-up options (not in this round's scope)

- **Retire** — delete `src/runtime/tools.ts`, `src/frontend/repl.ts`, `src/frontend/commands.ts` (if also unreachable), and `tests/tools.test.ts`. Net diff: ~600 LOC removed. Blocks: confirm no external reverse dependencies (linked node_modules consumers, tutorials referencing it).
- **Bridge fully** — re-route legacy write/read through `src/native/tools/{write,read}.ts` so the legacy runtime inherits `fs-policy` too. Net diff: ~80 LOC, low risk, but still no production consumer to justify.
- **Resurrect with the native dispatcher** — if a future feature wants a separate "source-first" frontend, rebuild it on top of `src/native/dispatch.ts` rather than `src/runtime/tools.ts`.

P0 + P1 round outputs: bash classifier shared, write/edit fs-policy live in production, legacy bash bridged, boundary test in place. Public sync is unblocked from a security-policy-consistency standpoint by these two rounds.
