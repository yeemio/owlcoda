# OwlCoda Tools — Maturity Matrix

> Refreshed 2026-06-23, owlcoda 0.15.12
> Source of truth: `src/native/dispatch.ts` default registration,
> `src/native/tool-defs.ts` schemas, and `src/native/tools/*.ts`
> behavioral audit (not comments).
> Scope: 69 native tool schemas/factories are tracked below. The default
> dispatcher currently advertises **68 registered tool_defs** through
> `buildNativeToolDefs(new ToolDispatcher())`. `Agent` is host-wired by
> `ink-repl.tsx` because it needs provider deps and is the only remaining
> schema-only surface. The "42+ tools" headline is therefore a
> lower-bound count, not a production-count claim.

## Summary

- **production**: 13
  bash, read, write, edit, glob, grep, NotebookEdit, WebFetch, WebSearch,
  EnterWorktree, ExitWorktree, TeamCreate, TeamDelete
- **beta**: 50
  Agent, AgentRunList, AgentRunGet, LongTaskList, LongTaskGet, LongTaskAwait,
  LongTaskReplace,
  RuntimeRecoveryList, RuntimeRecoveryGet,
  RuntimeLifecycleList, RuntimeLifecycleGet,
  RuntimeSupervisorList, RuntimeSupervisorGet,
  AgentControlList, AgentControlGet,
  AgentMailboxSend, AgentMailboxList, AgentMailboxGet, AgentMailboxResolve,
  JobList, JobGet, JobCancel, BrowserJob, ApiJob, ServiceJob,
  AskUserQuestion, Sleep,
  EnterPlanMode, ExitPlanMode, Config,
  TodoWrite, Skill, ToolSearch, StructuredOutput, Brief, PowerShell,
  TaskCreate, TaskList, TaskGet, TaskUpdate, TaskStop, TaskOutput,
  TaskVerify, DeliveryAudit, SkillRoutePreview, RunWorkspace,
  ProjectMap, ArtifactVerify, ProbePlan, JudgeBackendProbe
- **stub**: 1
  McpAuth
- **experimental**: 5
  RemoteTrigger, LSP, MCPTool, ListMcpResources, ReadMcpResource

Default registration truth: 68 registered tool_defs, 69 schema rows.
Schema-only / host-wired surfaces: Agent (registered by `ink-repl.tsx`
with live provider deps). Tungsten and Workflow were removed in 0.13.32 —
they were upstream-cloud-only placeholders that returned "not available"
in local mode and had no realistic local implementation path.

### Maturity/registration contract

- The table below must contain exactly one row for every
  `NATIVE_TOOL_SCHEMAS` key.
- The default advertised count must match both
  `new ToolDispatcher().getToolNames()` and `buildNativeToolDefs(...)`.
- Production rows must be default-registered and must not carry stub or
  orphan notes.
- Stub/orphan surfaces may stay documented while they are being retired,
  renamed, or wired, but they must not be counted as production.

## Tool-by-tool

| Name | LOC | Maturity | Real I/O | Test coverage | Notes |
| --- | --- | --- | --- | --- | --- |
| bash | 321 | production | spawn child_process (detached, pgid kill, timeout, progress) | bash.test.ts (271) — full | full implementation |
| read | 209 | production | fs/promises readFile + image handling, fs-policy sensitive-path gate | read.test.ts (164) + fs-policy.test.ts read cases — behavioral | full; sensitive reads denied without narrowing normal absolute-path reads |
| write | 73 | production | fs/promises writeFile via tmp + rename, fs-policy gate | write.test.ts (98) + write-edit-guard.test.ts (110) — behavioral | full |
| edit | 103 | production | fs/promises read/write, exact-match replacement, fs-policy gate | edit.test.ts (133) — behavioral | full |
| glob | 398 | production | spawn rg (with fallback walker) | glob.test.ts (101) | full; uses rg-detect helper |
| grep | 384 | production | spawn rg | grep.test.ts (145) | full |
| NotebookEdit | 220 | production | fs read/write, JSON parse, fs-policy gate | notebook-edit.test.ts (177) — behavioral | full nbformat handling |
| WebFetch | 137 | production | fetch() + html-to-text | none (no test file) | functional but UNTESTED |
| WebSearch | 153 | production | fetch() to DuckDuckGo lite + parse | none (no test file) | functional but UNTESTED; brittle DDG HTML scraping |
| EnterWorktree | 133 | production | execSync `git worktree add` + chdir | worktree.test.ts (150) | real git ops |
| ExitWorktree | 144 | production | execSync `git worktree remove`, change counting | worktree.test.ts (150) | real git ops |
| TeamCreate | 91 | production (label: experimental) | mkdir + writeFile under ~/.owlcoda/teams | team-create.test.ts (55) | real disk persistence; only "experimental" because the *team* feature itself is half-built (no agents actually consume the team dir) |
| TeamDelete | 83 | production (label: experimental) | rm + readFile under ~/.owlcoda | team-delete.test.ts (61) | real disk; same caveat |
| Agent | 589 | beta | spawns sub-conversation via runConversationLoop, real provider calls | agent.test.ts (299) — behavioral | schema/factory exists; host-wired by ink-repl.tsx with provider deps, not default-registered |
| AgentRunList | 34 | beta | reads in-memory Agent run history | agent.test.ts + dispatch/tool-risk/tool-defs coverage | read-only lifecycle inspection; bounded recent history only, no resume/retry/background scheduler |
| AgentRunGet | 25 | beta | reads one in-memory Agent run history record | agent.test.ts + dispatch/tool-risk/tool-defs coverage | read-only detail inspection by agentId; no resume/retry/background scheduler |
| LongTaskList | 417 | beta | reads runtime-owned long-task lifecycle snapshot registry | long-task.test.ts + dispatch/tool-risk/tool-defs coverage | read-only lifecycle registry list; reports status/supervision/waitability/inspect command, no wait/resume/retry/background scheduler |
| LongTaskGet | 417 | beta | reads one runtime-owned long-task lifecycle snapshot | long-task.test.ts + dispatch/tool-risk/tool-defs coverage | read-only detail inspection by longTaskId; exposes lifecycle verdict and wait/replacement policy, no background scheduler |
| LongTaskAwait | 417 | beta | bounded runtime wait over the long-task lifecycle snapshot registry | long-task.test.ts + dispatch/tool-risk/tool-defs coverage | read-only wait-policy executor; replaces ad hoc Sleep/bash polling for waitable records, but does not resume/retry/background supervise |
| LongTaskReplace | 417 | beta | creates a classified replacement TaskCreate-style command task from a replace_or_retry lifecycle record | long-task.test.ts + dispatch/tool-risk/tool-defs/headless-approval coverage | first-class replacement gate for lost-handle command tasks; refuses unsafe commands and does not auto-replay Agent records |
| RuntimeRecoveryList | 96 | beta | reads conversation-local runtime recovery ledger from ToolExecutionContext | runtime-recovery.test.ts + conversation-loop-guard/tool-risk/tool-defs coverage | read-only durable recovery checkpoint list; no resume/retry/background scheduler |
| RuntimeRecoveryGet | 96 | beta | reads one conversation-local runtime recovery checkpoint from ToolExecutionContext | runtime-recovery.test.ts + conversation-loop-guard/tool-risk/tool-defs coverage | read-only checkpoint payload/detail inspection; no resume/retry/task or agent mutation |
| RuntimeLifecycleList | 116 | beta | reads unified runtime lifecycle registry | run-lifecycle-tools.test.ts + run-lifecycle.test.ts + dispatch/tool-risk/tool-defs coverage | read-only truth spine list across task commands, agent runs, supervisor processes, mailbox messages, and checkpoints; no wait/resume/retry/mutation |
| RuntimeLifecycleGet | 116 | beta | reads one unified runtime lifecycle record | run-lifecycle-tools.test.ts + run-lifecycle.test.ts + dispatch/tool-risk/tool-defs coverage | read-only detail inspection by runId; gives inspect command and recovery policy so resume does not rely on transcript memory |
| RuntimeSupervisorList | 68 | beta | reads runtime-supervised command process snapshots | runtime-supervisor.test.ts + dispatch/tool-risk/tool-defs coverage | read-only process snapshot list for TaskCreate(command) work; not a daemon/job supervisor and does not kill/wait/retry work |
| RuntimeSupervisorGet | 68 | beta | reads one runtime-supervised command process snapshot | runtime-supervisor.test.ts + dispatch/tool-risk/tool-defs coverage | read-only detail inspection by processId; exposes process identity, parent run, inspect command, and replacement caution |
| AgentControlList | 68 | beta | projects Agent run history into parent/child control records | agent-control.test.ts + agent.test.ts + dispatch/tool-risk/tool-defs coverage | read-only AgentControl view with parent run links and recovery policy; does not spawn/resume/retry agents |
| AgentControlGet | 68 | beta | reads one AgentControl record by agentId | agent-control.test.ts + agent.test.ts + dispatch/tool-risk/tool-defs coverage | read-only detail inspection by agentId; points back to AgentRunGet and inspect-before-retry recovery |
| AgentMailboxSend | 150 | beta | mutates in-memory runtime mailbox queue | agent-mailbox.test.ts + dispatch/tool-risk/tool-defs coverage | queues structured parent/agent messages and mirrors them to run lifecycle; v1 does not directly wake a sub-agent turn |
| AgentMailboxList | 150 | beta | reads in-memory runtime mailbox queue | agent-mailbox.test.ts + dispatch/tool-risk/tool-defs coverage | read-only mailbox inspection with recipient/status filters; prevents duplicate transcript-only instructions |
| AgentMailboxGet | 150 | beta | reads one runtime mailbox message | agent-mailbox.test.ts + dispatch/tool-risk/tool-defs coverage | read-only detail by messageId; body is preserved outside free-form transcript |
| AgentMailboxResolve | 150 | beta | marks a runtime mailbox message resolved | agent-mailbox.test.ts + dispatch/tool-risk/tool-defs coverage | internal-state resolution only; records terminal lifecycle evidence but does not deliver/resume agents |
| JobList | 324 | beta | reads in-memory platform job supervisor records | job.test.ts + dispatch/tool-risk/tool-defs coverage | read-only job registry list for command, browser, API, and service jobs; no mutation |
| JobGet | 324 | beta | reads one platform job supervisor record | job.test.ts + dispatch/tool-risk/tool-defs coverage | read-only detail by jobId; exposes status, artifacts, external handle, and recovery hints |
| JobCancel | 324 | beta | mutates platform job supervisor state and invokes registered cleanup | job.test.ts + dispatch/tool-risk/tool-defs coverage | cancels command-backed jobs through the task cleanup path; non-command jobs are marked cancelled without pretending an unknown external handle was killed |
| BrowserJob | 1139 | beta | fetch/Chrome/CDP browser replay and artifact capture | browser-job.test.ts + job-supervisor.test.ts + dispatch/tool-risk/tool-defs coverage | supervised browser capture with fetch_html, chrome_headless, and chrome_cdp providers; records screenshot/DOM/text/console/network artifacts where supported |
| ApiJob | 310 | beta | HTTP(S) API request with response artifacts | api-job.test.ts + dispatch/tool-risk/tool-defs coverage | supervised API probe job with timeout, artifact registry integration, and live cancellation surface |
| ServiceJob | 496 | beta | child_process spawn/stop/restart plus optional health probe | service-job.test.ts + dispatch/tool-risk/tool-defs coverage | supervised local dev service lifecycle with PID, port, log artifacts, health URL, graceful stop, and recovery hints |
| AskUserQuestion | 173 | beta | host UI callback or readline fallback on stdin | none directly (covered indirectly) | depends on ToolExecutionContext.askUserQuestion |
| Sleep | 45 | beta | setTimeout | none (no test file) | trivial; works |
| EnterPlanMode | 59 | beta | mutates shared PlanModeState | enter-plan-mode.test.ts (52) | state-only; no enforcement of "no writes during plan mode" inside the tool itself |
| ExitPlanMode | 49 | beta | mutates shared PlanModeState | exit-plan-mode.test.ts (57) | state-only |
| Config | 110 | beta | reads/writes process.env + tui theme | config.test.ts (104) — behavioral | only 4 settings (theme, model, verbose, autoCompact); not persisted to disk |
| TodoWrite | 93 | beta | mutates module-level array | none (no test file) | session-only in-memory list; no persistence |
| Skill | 225 | beta | unified curated + learned registry via loadAllSkills() | skill.test.ts (81) — registry/actions/error paths | same source of truth as slash /skills; list/info/run accept curated library entries |
| ToolSearch | 87 | beta | reads NATIVE_TOOL_SCHEMAS map | tool-search.test.ts (47) | string matching against in-memory schema map |
| StructuredOutput | 40 | beta | none (passes input through JSON.stringify) | structured-output.test.ts (29) | no schema validation despite description; just pretty-prints |
| Brief | 71 | beta | stat/access for attachment validation | brief.test.ts (33) — schema/error only | validates files exist; doesn't actually upload anywhere |
| PowerShell | 63 | beta | execFile pwsh / powershell.exe | powershell.test.ts (22) | shells out to pwsh if installed; correct error path otherwise |
| DeliveryAudit | 583 | beta | reads git/status/files and can lint weak test assertions | delivery-audit.test.ts | local audit helper; useful for honesty checks but not a release gate by itself |
| SkillRoutePreview | 61 | beta | classifies a prompt against skill routing logic | skill-route-preview.test.ts | read-only preview; no artifact creation |
| RunWorkspace | 361 | beta | creates/reads `.owlcoda-run` metadata, ledger, artifacts, checkpoints | run-workspace.test.ts | real disk persistence for run metadata; not a job executor |
| ProjectMap | 136 | beta | bounded default-on project scan plus optional `.owlcoda-run/project-map.json` persistence | project-map.test.ts + project-map-dogfood-acceptance.test.ts | Runtime Control Plane snapshot surface; `OWLCODA_PROJECT_MAP=0` is the rollback override; not a full-repo index, does not execute commands, and does not bypass write gates |
| ArtifactVerify | 108 | beta | runs supported artifact verification packs | artifact-verify.test.ts | currently supports `html_deck`; narrow verification helper |
| ProbePlan | 376 | beta | stores probe plans and optionally mutates live conversation options | probe-plan.test.ts | default dispatcher has no live-conversation accessor; ink-repl re-registers it with one |
| JudgeBackendProbe | 37 | beta | probes OpenAI-compatible chat/completions endpoints with fixed prompts | judge-backend-probe.test.ts + tools/judge-backend-probe.test.ts + dispatch/tool-risk/tool-defs coverage | real local/remote HTTP calls; useful for checking model/backend JSON reliability, not a release gate |
| TaskCreate | 49 | beta | in-memory task entry; optional safe_readonly bash child via task-store | task-create.test.ts (163) — behavior + safety gates | pure-TODO mode is still manual; command mode only spawns after bash-risk + headless-approval + direct safe_readonly recheck |
| TaskList | 59 | beta | reads in-memory Map | task-list.test.ts | in-memory session task list; not a process/job discovery tool |
| TaskGet | 57 | beta | reads in-memory Map | task-get.test.ts (48) | returns task record fields; command output is surfaced by TaskOutput |
| TaskUpdate | 108 | beta | mutates in-memory Map | task-update.test.ts (74) | manual task annotation/status changes; never executes work |
| TaskStop | 62 | beta | cancels Map entry; SIGTERM for TaskCreate command-backed child | task-stop.test.ts (57) | only stops processes launched through TaskCreate(command=...); pure-TODO tasks are status-only |
| TaskOutput | 115 | beta | reads Map and captured stdout/stderr/exitCode for command-backed tasks | task-output.test.ts (51) | block=true only makes sense for command-backed tasks or tasks another turn will update |
| TaskVerify | 362 | beta | runs task-step verification checks and writes results back to task-store | task-verify.test.ts | real verification runner for file/command/artifact checks; still session-scoped task state |
| McpAuth | 77 | stub | mutates in-memory Map | mcp-auth.test.ts (42) | **records `authenticated: true` regardless of token validity**; no real auth flow even when MCP manager is connected |
| RemoteTrigger | 127 | experimental | fs read/write under ~/.owlcoda/triggers | remote-trigger.test.ts (64) | **`run` action only updates a `lastRun` timestamp — does not actually invoke anything**; create/list/get/update do real disk I/O |
| LSP | 71 | experimental | none with default provider; delegates if a provider is wired | lsp.test.ts (38) | default provider is a "not available" stub. No LSP provider is wired in dispatch.ts |
| MCPTool | 64 | experimental | none with default provider; delegates to MCPManager when constructor is given one | mcp-tool.test.ts (38) | dispatch.ts passes mcpManager through, so this is real iff an MCP server is connected; otherwise stub |
| ListMcpResources | 71 | experimental | same as MCPTool | list-mcp-resources.test.ts (34) | same |
| ReadMcpResource | 61 | experimental | same as MCPTool | read-mcp-resource.test.ts (38) | same |

### Infrastructure (excluded from native tool schema/registration counts)

| File | Role |
| --- | --- |
| types.ts | shared NativeToolDef, ToolResult, input typings |
| index.ts | barrel export |
| fs-policy.ts | shared write-path guard used by Write/Edit/NotebookEdit |
| ignore.ts | shared ignore patterns used by Glob/Grep |
| rg-detect.ts | ripgrep binary detection used by Glob/Grep |
| task-store.ts | in-memory Task store used by all Task* tools |

## Stub tools that need attention

1. **McpAuth** — does not validate tokens or perform OAuth. Fix: route
   into the MCP manager's auth flow (or remove the OAuth branch which
   is misleading).

2. **RemoteTrigger.run** — stores and reports, doesn't trigger anything.
   Fix: wire `run` to actually fire the trigger's payload, or document
   this as a "log only" stub.

> **Deleted in the ADR-007 stub sweep**: **SendMessage** (in-memory
> queue with no consumer — multi-agent passing goes through `Agent`
> worktree-isolated file handoff) and **ScheduleCron** (stored cron
> strings that never fired — scheduling is delegated to external cron
> + `owlcoda run`, per the anti-roadmap).

3. **Task tools** — no longer pure stubs in 0.13.31: TaskCreate can
   launch safe_readonly commands, TaskOutput surfaces captured I/O, and
   TaskStop signals TaskCreate-owned children. Remaining caveat: the
   backing store is still in-memory/session-lifetime only, and pure-TODO
   tasks still need explicit TaskUpdate. Keep calling this beta, not a
   durable job scheduler.

## False advertising risk

The headline "42+ native tools" is still a defensible lower-bound
because the default dispatcher advertises 68 registered tool_defs. The
risk is in the *implication* that all advertised tools are production
features:

- **Task coordination** — 7 tools (TaskCreate, TaskList, TaskGet,
  TaskUpdate, TaskStop, TaskOutput, TaskVerify) are real but **beta**.
  They share an in-memory session store. TaskCreate has a command-backed
  path for safe_readonly commands only; TaskOutput can show captured I/O;
  TaskStop can signal those TaskCreate-owned children; TaskVerify can
  evaluate step checks. This is still not a durable scheduler, queue,
  worker pool, or remote agent runtime.

- **Project Map Runtime Control Plane** — ProjectMap is real but **beta**
  and default-on with `OWLCODA_PROJECT_MAP=0` rollback. It provides bounded project
  orientation, runtime evidence, dogfood acceptance, and TaskCreate /
  TaskVerify verification-profile bridging. It is not a full-repo index,
  embedding index, repo graph, hook runner, or write-authorization bypass.

- **Team coordination** — TeamCreate/TeamDelete create directories
  but nothing else uses them, advertising "multi-agent teamwork"
  that doesn't exist as runtime behavior. (SendMessage, the in-memory
  inbox with no consumer, was removed in the ADR-007 stub sweep.)

- **Scheduling** — RemoteTrigger.run looks like it enables
  scheduling/automation but has no executor. (ScheduleCron was removed
  in the ADR-007 stub sweep; scheduling is delegated to external cron
  + `owlcoda run`.)

- **MCP** — three MCP tools and McpAuth all *can* work when an MCP
  manager is wired (dispatch passes one through). McpAuth specifically
  is not wired through MCPManager and will rubber-stamp any token.

- **LSP** — the default provider is a "not available" stub and no
  real provider is wired in dispatch.ts. The CLI advertising LSP
  capability is misleading until someone calls `createLSPTool(provider)`
  with a real provider.

Recommendation: keep the headline "42+ tools" only when paired with an
honest split such as "13 production, 50 beta, 1 stub, 5 experimental;
68 default-registered tool_defs; 1 schema-only/host-wired surface".
For user-facing marketing, lead with the production/beta capabilities
and hide or gate the remaining stubs behind an experimental surface.
