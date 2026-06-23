/**
 * OwlCoda Native Tool Definitions
 *
 * Shared Anthropic-format tool_def schemas for all native tools.
 * Used by both REPL and headless mode to register tools with the API.
 */

import type { ToolDispatcher } from './dispatch.js'
import { buildToolDef } from './protocol/request.js'

/** JSON Schema definitions for each native tool's input parameters. */
export const NATIVE_TOOL_SCHEMAS: Record<string, Record<string, unknown>> = {
  bash: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The bash command to execute' },
      cwd: { type: 'string', description: 'Working directory' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds' },
    },
    required: ['command'],
  },
  read: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to read' },
      startLine: { type: 'number', description: '1-based start line' },
      endLine: { type: 'number', description: '1-based end line' },
      offset: { type: 'number', description: 'Byte offset' },
      limit: { type: 'number', description: 'Max bytes to read' },
    },
    required: ['path'],
  },
  write: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write' },
      content: { type: 'string', description: 'Content to write' },
      createDirs: { type: 'boolean', description: 'Create parent directories' },
      replaceProtected: {
        type: 'boolean',
        description:
          'Set true to acknowledge a destructive overwrite of a protected ' +
          'source-of-truth file (NEXT_THREAD_HANDOFF.md, GOAL_CONTRACT.md, ' +
          'CHANGELOG.md, SOURCE_OF_TRUTH.md, docs/handoff/**). The ' +
          'protected-source policy refuses destructive overwrites by default; ' +
          'setting this flag is the operator\'s "I know I\'m replacing the ' +
          'file" signal. Append-only writes never need this flag.',
      },
    },
    required: ['path', 'content'],
  },
  edit: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to edit' },
      oldStr: { type: 'string', description: 'String to find (must be unique)' },
      newStr: { type: 'string', description: 'Replacement string' },
      replaceProtected: {
        type: 'boolean',
        description:
          'See write.replaceProtected — same contract for edits that remove ' +
          'a large fraction of a protected file (e.g. oldStr = entire section, ' +
          'newStr = "").',
      },
    },
    required: ['path', 'oldStr', 'newStr'],
  },
  glob: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern' },
      cwd: { type: 'string', description: 'Base directory' },
      ignore: { type: 'array', items: { type: 'string' }, description: 'Ignore patterns' },
    },
    required: ['pattern'],
  },
  grep: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: { type: 'string', description: 'File or directory to search' },
      include: { type: 'string', description: 'File glob filter (e.g. *.ts)' },
      ignoreCase: { type: 'boolean', description: 'Case insensitive search' },
      maxResults: { type: 'number', description: 'Max results to return' },
    },
    required: ['pattern'],
  },
  WebFetch: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch content from' },
      prompt: { type: 'string', description: 'Optional prompt describing what to look for in the content' },
    },
    required: ['url'],
  },
  WebSearch: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query to use' },
      maxResults: { type: 'number', description: 'Maximum number of results (default: 8)' },
    },
    required: ['query'],
  },
  TodoWrite: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The updated todo list',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Task description (imperative form)' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Task status' },
            activeForm: { type: 'string', description: 'Task description (present continuous form)' },
          },
          required: ['content', 'status', 'activeForm'],
        },
      },
    },
    required: ['todos'],
  },
  AskUserQuestion: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user' },
      options: {
        type: 'array',
        description: 'Optional list of choices',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Option label' },
            description: { type: 'string', description: 'Optional description' },
          },
          required: ['label'],
        },
      },
      multiSelect: { type: 'boolean', description: 'Allow multiple selections' },
    },
    required: ['question'],
  },
  Sleep: {
    type: 'object',
    properties: {
      durationSeconds: { type: 'number', description: 'Duration in seconds to sleep' },
    },
    required: ['durationSeconds'],
  },
  Agent: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'A short (3-5 word) description of the task' },
      prompt: { type: 'string', description: 'The task for the agent to perform' },
      subagent_type: { type: 'string', description: 'Agent type: "general-purpose" (default) or "Explore" (read-only)' },
      model: { type: 'string', description: 'Optional model id for the sub-agent. Defaults to the parent conversation model. Use a different model to isolate orchestration sub-agents from a data-generation backend (so one backend outage does not take down the whole fan-out).' },
      max_iterations: { type: 'number', description: 'Optional iteration budget for long-running sub-agent work. Defaults to 200 for general-purpose agents and 80 for Explore agents.' },
      idle_timeout_ms: { type: 'number', description: 'Optional per-call idle watchdog timeout in milliseconds for known long-running sub-agent work. Positive values only; 0/invalid values are ignored so the Agent call cannot disable the idle guard.' },
      max_runtime_ms: { type: 'number', description: 'Optional per-call maximum runtime watchdog timeout in milliseconds for known long-running sub-agent work. Positive values only; 0/invalid values are ignored so the Agent call cannot disable the hard ceiling.' },
      expectedArtifacts: {
        type: 'array',
        description: 'Slice 5 artifact contract: when non-empty, the sub-agent MUST touch at least one path matching each artifact or the tool returns isError=true. Omit for text/research agents that do not write files.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Expected output path' },
            kind: { type: 'string', enum: ['file', 'directory'] },
            origin: { type: 'string', enum: ['explicit', 'parent_directory', 'derived_test', 'touched', 'user_approved', 'user-external', 'external_reference', 'run_workspace'] },
          },
          required: ['path', 'kind', 'origin'],
        },
      },
      parentTaskId: { type: 'string', description: 'Parent task ID for traceability (optional).' },
      parentStepId: { type: 'string', description: 'Parent step ID for traceability (optional).' },
    },
    required: ['description', 'prompt'],
  },
  AgentRunList: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum recent Agent runs to return. Defaults to 20; capped by the runtime history limit.' },
    },
    description: 'Read-only inspection of recent Agent run lifecycle records. This does not resume, retry, or mutate sub-agents.',
  },
  AgentRunGet: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'Agent run ID returned by Agent metadata or AgentRunList.' },
    },
    required: ['agentId'],
    description: 'Read one Agent run lifecycle record by ID. Read-only; this does not resume, retry, or mutate sub-agents.',
  },
  LongTaskList: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum recent long-task lifecycle records to return. Defaults to 20; capped by the runtime registry limit.' },
    },
    description: 'Read-only inspection of runtime-owned long-task lifecycle records for the current conversation. This does not wait, resume, retry, or mutate tasks or agents.',
  },
  LongTaskGet: {
    type: 'object',
    properties: {
      longTaskId: { type: 'string', description: 'Long task ID returned by LongTaskList, such as task:task-1 or agent:agent-D1.' },
    },
    required: ['longTaskId'],
    description: 'Read one runtime-owned long-task lifecycle record by ID. Read-only; this does not wait, resume, retry, or mutate tasks or agents.',
  },
  LongTaskAwait: {
    type: 'object',
    properties: {
      longTaskId: { type: 'string', description: 'Long task ID returned by LongTaskList, such as task:task-1 or agent:agent-D1.' },
      timeoutMs: { type: 'number', description: 'Optional runtime wait budget in milliseconds. The runtime clamps this to the long-task wait_policy max_wait_ms.' },
    },
    required: ['longTaskId'],
    description: 'Use the runtime-managed wait policy for one waitable long task. Read-only; this does not resume, retry, or mutate tasks or agents.',
  },
  LongTaskReplace: {
    type: 'object',
    properties: {
      longTaskId: { type: 'string', description: 'Long task ID returned by LongTaskList/LongTaskGet whose wait_policy strategy is replace_or_retry.' },
      command: {
        type: 'string',
        description: 'Optional safe_readonly replacement command. When omitted, runtime reuses the original classified command from the task_command lifecycle snapshot. Dangerous, unknown, or needs_approval commands are refused.',
      },
      cwd: { type: 'string', description: 'Optional working directory for the replacement command. Defaults to the original task cwd when available.' },
      subject: { type: 'string', description: 'Optional subject for the replacement task.' },
      description: { type: 'string', description: 'Optional description for the replacement task.' },
      reason: { type: 'string', description: 'Optional reason recorded on the replacement task metadata.' },
    },
    required: ['longTaskId'],
    description: 'Runtime-controlled replacement path for replace_or_retry long-task records. Only command-backed task_command records can be replaced automatically; Agent records require an explicit new Agent call.',
  },
  RuntimeRecoveryList: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum recent runtime recovery checkpoints to return. Defaults to 20; capped by the runtime ledger limit.' },
      includeResolved: { type: 'boolean', description: 'When true, include resolved and superseded checkpoint history. Defaults to false so stale checkpoints do not steer recovery.' },
    },
    description: 'Read-only inspection of durable runtime recovery checkpoints for the current conversation. This does not resume, retry, or mutate tasks or agents.',
  },
  RuntimeRecoveryGet: {
    type: 'object',
    properties: {
      checkpointId: { type: 'string', description: 'Runtime recovery checkpoint ID returned by RuntimeRecoveryList or the recovery ledger prompt.' },
    },
    required: ['checkpointId'],
    description: 'Read one durable runtime recovery checkpoint by ID. Read-only; this does not resume, retry, or mutate tasks or agents.',
  },
  JobList: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum recent platform job supervisor records to return. Defaults to 20; capped by the runtime registry limit.' },
      status: { type: 'string', description: 'Optional exact job status filter, such as running, waiting, done, failed, cancelled, or timeout.' },
      type: { type: 'string', description: 'Optional exact job type filter, such as command, agent, browser, or api.' },
    },
    description: 'Read-only inspection of platform job supervisor records. This does not wait, cancel, resume, or mutate jobs.',
  },
  JobGet: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'Platform job ID returned by JobList or command-backed TaskCreate metadata, such as job:task:task-1.' },
    },
    required: ['jobId'],
    description: 'Read one platform job supervisor record by ID. Read-only; this does not wait, cancel, resume, or mutate the job.',
  },
  RuntimeLifecycleList: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum recent runtime lifecycle records to return. Defaults to 20.' },
      kind: { type: 'string', description: 'Optional run kind filter: task_command, agent_run, supervisor_process, mailbox_message, or runtime_checkpoint.' },
    },
    description: 'Read-only inspection of the unified runtime truth spine: task commands, agent runs, supervisor processes, mailbox messages, and checkpoints. This does not wait, resume, retry, or mutate work.',
  },
  RuntimeLifecycleGet: {
    type: 'object',
    properties: {
      runId: { type: 'string', description: 'Unified runtime lifecycle run ID returned by RuntimeLifecycleList, such as task:task-1, agent:agent-D1, process:task-1, or mailbox:mailbox-1.' },
    },
    required: ['runId'],
    description: 'Read one unified runtime lifecycle record by runId. Read-only; this does not wait, resume, retry, or mutate work.',
  },
  RuntimeSupervisorList: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum recent runtime-supervised process snapshots to return. Defaults to 20.' },
    },
    description: 'Read-only inspection of runtime-supervised process snapshots for command-backed long tasks. This does not wait, kill, resume, retry, or mutate work.',
  },
  RuntimeSupervisorGet: {
    type: 'object',
    properties: {
      processId: { type: 'string', description: 'Runtime supervisor process ID returned by RuntimeSupervisorList, such as process:task-1.' },
    },
    required: ['processId'],
    description: 'Read one runtime-supervised process snapshot by processId. Read-only; this does not wait, kill, resume, retry, or mutate work.',
  },
  AgentControlList: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum recent AgentControl records to return. Defaults to 20.' },
    },
    description: 'Read-only inspection of AgentControl records with parent run links, status, inspect commands, and recovery policy. This does not spawn, resume, retry, or mutate agents.',
  },
  AgentControlGet: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'Agent ID returned by AgentControlList or AgentRunList.' },
    },
    required: ['agentId'],
    description: 'Read one AgentControl record by agentId. Read-only; this does not spawn, resume, retry, or mutate agents.',
  },
  AgentMailboxSend: {
    type: 'object',
    properties: {
      author: { type: 'string', description: 'Mailbox author, for example root or agent:agent-D1.' },
      recipient: { type: 'string', description: 'Mailbox recipient, for example root or agent:agent-D1.' },
      body: { type: 'string', description: 'Structured message body to preserve outside the free-form transcript.' },
      parentRunId: { type: 'string', description: 'Optional parent runtime run ID that this message belongs to.' },
      triggerTurn: { type: 'boolean', description: 'Whether this message should be treated as turn-triggering intent by future AgentControl implementations. This v1 tool queues the intent but does not directly resume a sub-agent.' },
    },
    required: ['author', 'recipient', 'body'],
    description: 'Queue a structured parent/agent mailbox message in runtime state. Internal-state only; this does not directly resume a sub-agent turn.',
  },
  AgentMailboxList: {
    type: 'object',
    properties: {
      recipient: { type: 'string', description: 'Optional recipient filter.' },
      status: { type: 'string', enum: ['queued', 'delivered', 'acknowledged', 'resolved'], description: 'Optional mailbox status filter.' },
      limit: { type: 'number', description: 'Maximum recent mailbox messages to return. Defaults to 20.' },
    },
    description: 'Read-only inspection of structured parent/agent mailbox messages. This does not deliver, resume, retry, or mutate agents.',
  },
  AgentMailboxGet: {
    type: 'object',
    properties: {
      messageId: { type: 'string', description: 'Mailbox message ID returned by AgentMailboxSend or AgentMailboxList.' },
    },
    required: ['messageId'],
    description: 'Read one structured parent/agent mailbox message by messageId. Read-only; this does not deliver, resume, retry, or mutate agents.',
  },
  AgentMailboxResolve: {
    type: 'object',
    properties: {
      messageId: { type: 'string', description: 'Mailbox message ID to mark resolved.' },
      reason: { type: 'string', description: 'Optional resolution reason recorded into runtime lifecycle evidence.' },
    },
    required: ['messageId'],
    description: 'Mark a structured parent/agent mailbox message as resolved in runtime state. Internal-state only; this does not deliver, resume, retry, or mutate agents.',
  },
  JobCancel: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'Platform job ID returned by JobList or command-backed TaskCreate metadata, such as job:task:task-1.' },
      reason: { type: 'string', description: 'Optional cancellation reason recorded as terminationReason. Defaults to user_cancel.' },
    },
    required: ['jobId'],
    description: 'Cancel one platform job supervisor record. Command-backed TaskCreate jobs use the task cleanup path; non-command jobs are marked cancelled without claiming an external handle was killed.',
  },
  BrowserJob: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'HTTP(S) URL to capture through the platform-supervised browser job lifecycle.' },
      provider: { type: 'string', enum: ['fetch_html', 'chrome_headless', 'chrome_cdp'], description: 'Browser provider. fetch_html uses HTTP fetch; chrome_headless shells out for screenshot/DOM; chrome_cdp uses Chrome DevTools Protocol for click replay.' },
      chromeExecutablePath: { type: 'string', description: 'Optional Chrome/Chromium executable path for provider=chrome_headless or provider=chrome_cdp. When omitted, OwlCoda probes common local install paths.' },
      waitForSelector: { type: 'string', description: 'Optional simple selector to require before the job is considered complete. Supports #id, .class, tag, and simple [attr=value] checks in the fetch_html provider.' },
      clickSelector: { type: 'string', description: 'Optional selector to click during provider=chrome_cdp replay before final waits/artifact capture.' },
      waitForResponseUrlIncludes: { type: 'string', description: 'Optional substring of a network response URL to wait for during provider=chrome_cdp replay.' },
      waitAfterClickMs: { type: 'number', description: 'Optional delay after click for provider=chrome_cdp, before final selector/response checks and artifacts.' },
      artifactDir: { type: 'string', description: 'Optional directory for captured browser artifacts. Defaults to .owlcoda-browser-jobs under cwd.' },
      cwd: { type: 'string', description: 'Working directory used to resolve artifactDir. Defaults to the current process cwd.' },
      deadlineMs: { type: 'number', description: 'Total deadline in milliseconds. Defaults to 30000 and is capped by the runtime.' },
      runRef: { type: 'string', description: 'Optional RunWorkspace output root, .owlcoda-run directory, or manifest path. When provided, artifacts are recorded in the run artifact registry.' },
      environment: { type: 'string', description: 'Optional environment label recorded on RunWorkspace browser artifacts.' },
      project: { type: 'string', description: 'Optional project name recorded on RunWorkspace browser artifacts.' },
      origin: { type: 'string', description: 'Optional artifact origin. Defaults to browser_job when runRef is provided.' },
      stepId: { type: 'string', description: 'Optional step id recorded on RunWorkspace browser artifacts.' },
      participatesInFinal: { type: 'boolean', description: 'Whether browser artifacts participate in final delivery. Defaults to RunWorkspace behavior.' },
    },
    required: ['url'],
    description: 'Run a platform-supervised browser-style capture job. Providers: fetch_html, chrome_headless, and chrome_cdp. Records artifacts plus job lifecycle status.',
  },
  ApiJob: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'HTTP(S) API URL to request through the platform-supervised API job lifecycle.' },
      method: { type: 'string', enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method. Defaults to GET. GET/HEAD requests cannot include body.' },
      headers: { type: 'object', description: 'Optional HTTP request headers. Values must be strings.' },
      body: { type: 'string', description: 'Optional request body for POST, PUT, PATCH, or DELETE requests.' },
      artifactDir: { type: 'string', description: 'Optional directory for response artifacts. Defaults to .owlcoda-api-jobs under cwd.' },
      cwd: { type: 'string', description: 'Working directory used to resolve artifactDir. Defaults to the current process cwd.' },
      deadlineMs: { type: 'number', description: 'Total deadline in milliseconds. Defaults to 30000 and is capped by the runtime.' },
      runRef: { type: 'string', description: 'Optional RunWorkspace output root, .owlcoda-run directory, or manifest path. When provided, response artifacts are recorded in the run artifact registry.' },
      environment: { type: 'string', description: 'Optional environment label recorded on RunWorkspace API artifacts.' },
      project: { type: 'string', description: 'Optional project name recorded on RunWorkspace API artifacts.' },
      origin: { type: 'string', description: 'Optional artifact origin. Defaults to api_job when runRef is provided.' },
      stepId: { type: 'string', description: 'Optional step id recorded on RunWorkspace API artifacts.' },
      participatesInFinal: { type: 'boolean', description: 'Whether API artifacts participate in final delivery. Defaults to RunWorkspace behavior.' },
    },
    required: ['url'],
    description: 'Run a platform-supervised HTTP(S) API request. Records response artifacts plus job lifecycle status, timeout, and live cancellation.',
  },
  ServiceJob: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'status', 'stop', 'restart'], description: 'Service lifecycle action.' },
      serviceName: { type: 'string', description: 'Stable local service name, such as demo-backend or vite-web.' },
      command: { type: 'string', description: 'Executable to start. Required for start, and for restart unless the service is already running.' },
      args: { type: 'array', description: 'Executable arguments. OwlCoda spawns without shell interpolation.', items: { type: 'string' } },
      env: { type: 'object', description: 'Optional string environment overrides for the service process.' },
      cwd: { type: 'string', description: 'Working directory used to start the service and resolve artifactDir.' },
      port: { type: 'number', description: 'Optional local port recorded as the service external handle.' },
      healthUrl: { type: 'string', description: 'Optional HTTP(S) health URL to wait for on start and probe on status.' },
      artifactDir: { type: 'string', description: 'Optional directory for service logs. Defaults to .owlcoda-service-jobs under cwd.' },
      deadlineMs: { type: 'number', description: 'Startup health deadline in milliseconds. Defaults to 30000 and is capped by the runtime.' },
      gracefulStopMs: { type: 'number', description: 'Grace period for SIGTERM before OwlCoda escalates to SIGKILL. Defaults to 3000.' },
    },
    required: ['action', 'serviceName'],
    description: 'Manage a local dev service through the platform job supervisor service lifecycle. Records PID, port, health, logs, cleanup, and recovery hints.',
  },
  JudgeBackendProbe: {
    type: 'object',
    properties: {
      endpoint: { type: 'string', description: 'OpenAI-compatible chat/completions endpoint or base URL to probe.' },
      models: {
        type: 'array',
        description: 'Backend model ids to compare for judge reliability.',
        items: { type: 'string' },
      },
      prompts: {
        type: 'array',
        description: 'Optional fixed judge prompts. Omit to use the built-in three-prompt probe set.',
        items: { type: 'string' },
      },
      timeoutMs: { type: 'number', description: 'Per-call timeout in milliseconds. Defaults to 45000.' },
      minJsonSuccessRate: { type: 'number', description: 'Required JSON success rate between 0 and 1. Defaults to 1.' },
      apiKey: { type: 'string', description: 'Optional bearer token for the endpoint.' },
      headers: { type: 'object', description: 'Optional additional request headers.' },
      maxTokens: { type: 'number', description: 'Max tokens for each probe call. Defaults to 256.' },
    },
    required: ['endpoint', 'models'],
  },
  EnterPlanMode: {
    type: 'object',
    properties: {},
    description: 'Enter plan mode for complex tasks requiring exploration and design before coding.',
  },
  ExitPlanMode: {
    type: 'object',
    properties: {
      allowedPrompts: {
        type: 'array',
        description: 'Bash operations allowed after plan approval',
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string', description: 'Tool name (e.g. "bash")' },
            prompt: { type: 'string', description: 'Semantic description of the action' },
          },
          required: ['tool', 'prompt'],
        },
      },
    },
    description: 'Present plan for approval and exit plan mode to start implementation.',
  },
  Config: {
    type: 'object',
    properties: {
      setting: { type: 'string', description: 'Setting key (e.g. "theme", "model", "verbose")' },
      value: { description: 'New value — omit to read current value' },
    },
    required: ['setting'],
  },
  NotebookEdit: {
    type: 'object',
    properties: {
      notebook_path: { type: 'string', description: 'Absolute path to the .ipynb notebook file' },
      cell_id: { type: 'string', description: 'Cell ID or index (e.g. "cell-3") to target' },
      new_source: { type: 'string', description: 'New source content for the cell' },
      cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'Cell type (required for insert)' },
      edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'Edit mode (default: replace)' },
    },
    required: ['notebook_path', 'new_source'],
  },
  EnterWorktree: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Optional name slug for the worktree branch' },
    },
    description: 'Create an isolated git worktree and switch into it.',
  },
  ExitWorktree: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['keep', 'remove'], description: '"keep" preserves worktree; "remove" deletes it' },
      discard_changes: { type: 'boolean', description: 'Must be true to remove with uncommitted changes' },
    },
    required: ['action'],
  },
  TaskCreate: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Short title for the task' },
      description: { type: 'string', description: 'Detailed description of work to do' },
      activeForm: { type: 'string', description: 'Task description in present continuous form' },
      metadata: { type: 'object', description: 'Optional metadata key-value pairs' },
      command: {
        type: 'string',
        description: 'Optional safe_readonly bash command to spawn as a background task. Dangerous, unknown, or needs_approval commands are refused; use bash for operator-approved commands.',
      },
      cwd: { type: 'string', description: 'Working directory for command execution' },
      deliverables: {
        type: 'array',
        description: 'Optional structured deliverable paths for this task plan',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            kind: { type: 'string', enum: ['file', 'directory'] },
            origin: { type: 'string', enum: ['explicit', 'parent_directory', 'derived_test', 'touched', 'user_approved', 'user-external', 'external_reference', 'run_workspace'] },
          },
          required: ['path', 'kind', 'origin'],
        },
      },
      steps: {
        type: 'array',
        description: 'Ordered execution steps for a structured task plan. Each step requires title and description. When present, creates an executable plan.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Optional step ID (auto-generated if omitted: step-1, step-2, ...)' },
            title: { type: 'string', description: 'Short step title' },
            description: { type: 'string', description: 'What this step does' },
            action: { type: 'object', description: 'How to execute this step (local_tool, subagent, or manual)' },
            expectedArtifacts: {
              type: 'array',
              description: 'Paths this step is expected to produce',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  kind: { type: 'string', enum: ['file', 'directory'] },
                  origin: { type: 'string', enum: ['explicit', 'parent_directory', 'derived_test', 'touched', 'user_approved', 'user-external', 'external_reference', 'run_workspace'] },
                },
                required: ['path', 'kind', 'origin'],
              },
            },
            verification: {
              type: 'array',
              description: 'Verification checks to run after this step completes',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  kind: { type: 'string', enum: ['file_exists', 'file_contains', 'artifact_count', 'command', 'verification_pack', 'run_verdict_gate', 'none'] },
                  path: { type: 'string' },
                  pattern: { type: 'string' },
                  root: { type: 'string' },
                  glob: { type: 'string' },
                  min: { type: 'number' },
                  command: { type: 'string' },
                  expectedExitCode: { type: 'number' },
                  packId: { type: 'string', enum: ['html_deck'], description: 'Verification pack ID when kind=verification_pack.' },
                  deckPath: { type: 'string', description: 'HTML deck path when kind=verification_pack and packId=html_deck.' },
                  expectedSections: { type: 'number', description: 'Exact expected section count for html_deck verification packs.' },
                  buildNotesPath: { type: 'string', description: 'Optional build notes path for html_deck verification packs.' },
                  requiredMarkers: {
                    type: 'array',
                    description: 'Required marker strings or { marker, label } objects for html_deck verification packs.',
                    items: {
                      anyOf: [
                        { type: 'string' },
                        {
                          type: 'object',
                          properties: {
                            marker: { type: 'string' },
                            label: { type: 'string' },
                          },
                          required: ['marker'],
                        },
                      ],
                    },
                  },
                  minFileSizeBytes: { type: 'number', description: 'Minimum deck file size in bytes for html_deck verification packs.' },
                  minSectionBytes: { type: 'number', description: 'Minimum inner-HTML bytes per section for html_deck packs. Default 200. Set to 0 to skip.' },
                  forbiddenTerms: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Terms that must not appear in deck HTML or build notes for html_deck verification packs.',
                  },
                  reason: { type: 'string' },
                },
                required: ['id', 'kind'],
              },
            },
            projectMapVerificationProfileIds: {
              type: 'array',
              description: 'Project Map verification profile IDs to expand into TaskVerify checks for this step. Requires an active Project Map snapshot. Commands are not auto-run; TaskVerify runs them later through the normal safe_readonly gate.',
              items: { type: 'string' },
            },
          },
          required: ['title', 'description'],
        },
      },
    },
    required: ['subject', 'description'],
  },
  TaskList: {
    type: 'object',
    properties: {},
    description: 'List all tasks in the session with their status.',
  },
  TaskGet: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The ID of the task to retrieve' },
    },
    required: ['taskId'],
  },
  TaskUpdate: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The task ID to update' },
      subject: { type: 'string', description: 'New subject' },
      description: { type: 'string', description: 'New description' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled', 'blocked', 'deleted'], description: 'New task-level status' },
      activeForm: { type: 'string', description: 'New active form description' },
      addBlocks: { type: 'array', items: { type: 'string' }, description: 'Task IDs this task should block' },
      removeBlocks: { type: 'array', items: { type: 'string' }, description: 'Task IDs to unblock' },
      stepId: { type: 'string', description: 'Step ID to update (triggers step-level update when present)' },
      stepStatus: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed', 'blocked', 'cancelled'], description: 'New status for the step' },
      touchedPaths: { type: 'array', items: { type: 'string' }, description: 'Paths touched during this step (appended to existing)' },
      verification: {
        type: 'array',
        description: 'Replacement verification checks for this step. Use this to correct an unsatisfiable or wrong TaskVerify spec, then re-run TaskVerify before completion. Replaces existing checks and clears stale results unless verificationResults is also supplied.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            kind: { type: 'string', enum: ['file_exists', 'file_contains', 'artifact_count', 'verification_pack', 'run_verdict_gate', 'command', 'none'] },
            packId: { type: 'string' },
            path: { type: 'string' },
            pattern: { type: 'string' },
            root: { type: 'string' },
            glob: { type: 'string' },
            min: { type: 'number' },
            deckPath: { type: 'string' },
            expectedSections: { type: 'number' },
            buildNotesPath: { type: 'string' },
            requiredMarkers: {
              type: 'array',
              items: {
                anyOf: [
                  { type: 'string' },
                  {
                    type: 'object',
                    properties: {
                      marker: { type: 'string' },
                      label: { type: 'string' },
                    },
                    required: ['marker'],
                  },
                ],
              },
            },
            minFileSizeBytes: { type: 'number' },
            minSectionBytes: { type: 'number' },
            forbiddenTerms: { type: 'array', items: { type: 'string' } },
            command: { type: 'string' },
            expectedExitCode: { type: 'number' },
            reason: { type: 'string' },
          },
          required: ['id', 'kind'],
        },
      },
      verificationResults: {
        type: 'array',
        description: 'Verification results to record for this step (replaces existing results)',
        items: {
          type: 'object',
          properties: {
            checkId: { type: 'string' },
            passed: { type: 'boolean' },
            detail: { type: 'string' },
            checkedAt: { type: 'string' },
            unsatisfiable: { type: 'boolean' },
            metadata: { type: 'object', description: 'Optional structured verification metadata, such as a verification pack result.' },
          },
          required: ['checkId', 'passed', 'checkedAt'],
        },
      },
      failureReason: { type: 'string', description: 'Failure reason for failed/blocked steps (required when stepStatus is failed or blocked)' },
    },
    required: ['taskId'],
  },
  TaskStop: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The task ID to stop' },
      shell_id: { type: 'string', description: 'Deprecated alias for task_id' },
    },
  },
  TaskVerify: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The task ID containing the step to verify' },
      stepId: { type: 'string', description: 'The step ID to verify' },
      writeBack: { type: 'boolean', description: 'Write results to step.verificationResults (default: true)' },
    },
    required: ['taskId', 'stepId'],
  },
  TaskOutput: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The task ID to get output from' },
      block: { type: 'boolean', description: 'Wait for completion (default: true)' },
      timeout: { type: 'number', description: 'Max wait time in ms (default: 30000)' },
    },
    required: ['task_id'],
  },
  TeamCreate: {
    type: 'object',
    properties: {
      team_name: { type: 'string', description: 'Team name (slug-safe: letters, numbers, hyphens, underscores)' },
      description: { type: 'string', description: 'Optional team description' },
    },
    required: ['team_name'],
  },
  TeamDelete: {
    type: 'object',
    properties: {
      team_name: { type: 'string', description: 'Name of the team to delete' },
    },
    required: ['team_name'],
  },
  ToolSearch: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query — "select:Tool1,Tool2" for exact or keyword search' },
      max_results: { type: 'number', description: 'Max results for keyword search (default: 10)' },
    },
    required: ['query'],
  },
  StructuredOutput: {
    type: 'object',
    properties: {
      schema: { type: 'object', description: 'JSON Schema the model output must conform to' },
      data: { description: 'The structured data payload' },
    },
    required: ['data'],
  },
  RemoteTrigger: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'list', 'delete', 'fire'], description: 'CRUD or fire action' },
      name: { type: 'string', description: 'Trigger name' },
      event: { type: 'string', description: 'Event type (for create)' },
      payload: { type: 'object', description: 'Event payload (for fire)' },
    },
    required: ['action'],
  },
  MCPTool: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP server name' },
      tool: { type: 'string', description: 'Tool name on the MCP server' },
      input: { type: 'object', description: 'Tool input parameters' },
    },
    required: ['server', 'tool'],
  },
  ListMcpResources: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP server name (omit for all servers)' },
      type: { type: 'string', description: 'Filter by resource type' },
    },
  },
  ReadMcpResource: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP server name' },
      uri: { type: 'string', description: 'Resource URI to read' },
    },
    required: ['server', 'uri'],
  },
  McpAuth: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['store', 'retrieve', 'delete', 'list'], description: 'Auth action' },
      server: { type: 'string', description: 'MCP server name' },
      tokenType: { type: 'string', description: 'Token type (e.g. "bearer", "oauth")' },
      token: { type: 'string', description: 'Token value (for store)' },
    },
    required: ['action', 'server'],
  },
  Skill: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'run', 'info'], description: 'Skill action' },
      name: { type: 'string', description: 'Skill name (for run/info)' },
      args: { type: 'object', description: 'Arguments to pass to the skill' },
    },
    required: ['action'],
  },
  LSP: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['diagnostics', 'hover', 'definition', 'references', 'symbols', 'completion'], description: 'LSP operation' },
      file_path: { type: 'string', description: 'Path to the source file' },
      line: { type: 'number', description: 'Line number (0-based)' },
      character: { type: 'number', description: 'Character offset (0-based)' },
      query: { type: 'string', description: 'Symbol query string' },
    },
    required: ['action', 'file_path'],
  },
  PowerShell: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'PowerShell command to execute' },
      cwd: { type: 'string', description: 'Working directory' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
    },
    required: ['command'],
  },
  Brief: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Brief message to send' },
      attachments: { type: 'array', items: { type: 'string' }, description: 'File paths to attach' },
    },
    required: ['message'],
  },
  DeliveryAudit: {
    type: 'object',
    properties: {
      claims: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of completion claims to verify (e.g., "added foo.ts", "shipped 0.13.44", "tests pass")',
      },
      expectedFiles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of files that should now exist on disk',
      },
      lintTestFiles: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional explicit test files to lint for vacuous assertions (wide-coverage names backed only by ' +
          'toBeDefined / toBeTruthy / not.toBeNull / not.toBeUndefined). Omit to auto-lint touched-this-turn ' +
          '*.test.ts|tsx|js|jsx|mjs|cjs files. Pass an empty array to skip the lint entirely.',
      },
    },
    required: [],
  },
  SkillRoutePreview: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'User prompt to classify and route. The tool is read-only and does not create artifacts.',
      },
    },
    required: ['prompt'],
  },
  RunWorkspace: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'create',
          'readManifest',
          'recordArtifact',
          'readLedger',
          'refreshLedger',
          'recordEvent',
          'writeCheckpoint',
          'readCheckpoint',
        ],
        description: 'Run metadata operation to perform.',
      },
      outputRoot: { type: 'string', description: 'Output root for create; .owlcoda-run is managed beneath it.' },
      cwd: { type: 'string', description: 'Working directory used to resolve relative outputRoot/runRef/path values.' },
      runRef: {
        type: 'string',
        description: 'Output root, .owlcoda-run directory, or manifest.json path for an existing run workspace.',
      },
      taskFamily: {
        type: 'string',
        enum: ['deck', 'code', 'image_asset', 'research', 'data_report', 'release', 'general'],
        description: 'Optional task family persisted in manifest.json on create.',
      },
      deliverableMode: {
        type: 'string',
        enum: ['read_only_review', 'text_deliverable', 'file_artifact_delivery', 'code_change', 'command_job', 'mixed_unknown'],
        description: 'Optional deliverable mode persisted in manifest.json on create.',
      },
      skillRoute: { type: 'object', description: 'Optional skill route JSON persisted on create.' },
      plan: { type: 'object', description: 'Optional execution plan JSON persisted on create.' },
      verification: { type: 'object', description: 'Optional verification JSON persisted on create.' },
      checkpoint: { type: 'object', description: 'Checkpoint JSON object persisted on create or used by writeCheckpoint.' },
      path: { type: 'string', description: 'Artifact path for recordArtifact. Relative paths resolve under manifest.outputRoot.' },
      origin: {
        type: 'string',
        description: 'Artifact origin for recordArtifact, e.g. write, edit, bash_detected, skill_asset_copy, manual.',
      },
      stepId: { type: 'string', description: 'Optional step id for recordArtifact or recordEvent.' },
      participatesInFinal: { type: 'boolean', description: 'Whether the recorded artifact participates in final delivery.' },
      sourcePath: { type: 'string', description: 'Source path for copied skill assets.' },
      event: { type: 'object', description: 'Event object for recordEvent; must contain type.' },
      type: { type: 'string', description: 'Top-level event type for recordEvent when event is omitted.' },
      at: { type: 'string', description: 'Optional ISO timestamp for recordEvent.' },
      message: { type: 'string', description: 'Optional event message for recordEvent.' },
      data: { type: 'object', description: 'Optional event data for recordEvent.' },
    },
    required: ['action'],
  },
  ProjectMap: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['scan', 'show', 'refresh'],
        description: 'Project Map operation: scan current project, show persisted RunWorkspace snapshot, or refresh persisted snapshot.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory used to scan the project and resolve runRef.',
      },
      runRef: {
        type: 'string',
        description: 'Output root, .owlcoda-run directory, or manifest.json path for an existing RunWorkspace.',
      },
      maxSourceBytes: {
        type: 'number',
        description: 'Optional cap for bytes read from each Project Map source file.',
      },
    },
    required: ['action'],
  },
  ArtifactVerify: {
    type: 'object',
    properties: {
      packId: {
        type: 'string',
        enum: ['html_deck'],
        description: 'Verification pack to run. Currently only html_deck is supported.',
      },
      deckPath: { type: 'string', description: 'HTML deck path to verify.' },
      expectedSections: { type: 'number', description: 'Exact expected number of <section> pages.' },
      buildNotesPath: {
        type: 'string',
        description: 'Optional build notes path. Defaults to build-notes.md beside deckPath.',
      },
      requiredMarkers: {
        type: 'array',
        description: 'Required marker strings or { marker, label } objects that must appear in deck HTML.',
        items: {
          anyOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                marker: { type: 'string' },
                label: { type: 'string' },
              },
              required: ['marker'],
            },
          ],
        },
      },
      minFileSizeBytes: { type: 'number', description: 'Minimum deck file size in bytes.' },
      minSectionBytes: { type: 'number', description: 'Minimum inner-HTML bytes per section. Default 200. Set to 0 to skip density check.' },
      forbiddenTerms: {
        type: 'array',
        items: { type: 'string' },
        description: 'Terms that must not appear in deck HTML or build notes.',
      },
    },
    required: ['packId', 'deckPath', 'expectedSections'],
  },
  ProbePlan: {
    type: 'object',
    properties: {
      groupId: {
        type: 'string',
        description: 'Group label, e.g. "A". Re-registering the same id replaces the prior plan.',
      },
      probes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable probe id, e.g. "A0", "A1".' },
            tool: { type: 'string', description: 'Expected tool name (e.g. "write", "bash").' },
            mustContain: { type: 'string', description: 'Substring that must appear in the tool input JSON for the probe to be marked satisfied.' },
            description: { type: 'string', description: 'Human-readable note (surfaced in the runtime inject message).' },
          },
          required: ['id', 'tool', 'mustContain'],
        },
        description: 'List of probes this group expects the model to fire.',
      },
    },
    required: ['groupId', 'probes'],
  },
}

/** Build Anthropic tool_def objects from the dispatcher's registered tools.
 *
 * The description is pulled from the tool factory itself
 * (`dispatcher.getToolDescription(name)`) so honest stub-disclosure copy
 * — "There is no consumer wired up to drain these queues",
 * "tokens are NOT validated", etc. — actually reaches the LLM. The
 * `Native ${name} tool` placeholder is only used when a factory forgot
 * to provide a description. */
export function buildNativeToolDefs(dispatcher: ToolDispatcher) {
  return dispatcher.getToolNames()
    .filter((name) => NATIVE_TOOL_SCHEMAS[name])
    .map((name) => {
      const description = dispatcher.getToolDescription(name) ?? `Native ${name} tool`
      return buildToolDef(name, description, NATIVE_TOOL_SCHEMAS[name]!)
    })
}

let _canonicalByLower: Map<string, string> | null = null
/**
 * Resolve a possibly-miscased tool name to its canonical registered form
 * (e.g. "Bash" → "bash", "WEBFETCH" → "WebFetch"); returns the input unchanged
 * when no schema matches. Models intermittently emit the wrong case (P2-12);
 * dispatch already normalizes at execution, but the risk/mode SAFETY gates
 * classify the raw name — so wrong-case bash was being downgraded from
 * `destructive` to `mutating` and auto-approved. Every classifier that gates on
 * the tool name must canonicalize through here. Lazy map so there is no
 * module-init/import-order hazard. No collisions: the registered names are
 * unique once lowercased (locked by dispatch.test.ts).
 */
export function canonicalToolName(name: string): string {
  if (!_canonicalByLower) {
    _canonicalByLower = new Map(
      Object.keys(NATIVE_TOOL_SCHEMAS).map((k) => [k.toLowerCase(), k]),
    )
  }
  return _canonicalByLower.get(name.toLowerCase()) ?? name
}
