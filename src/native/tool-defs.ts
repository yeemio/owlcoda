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
    },
    required: ['path', 'content'],
  },
  edit: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to edit' },
      oldStr: { type: 'string', description: 'String to find (must be unique)' },
      newStr: { type: 'string', description: 'Replacement string' },
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
    },
    required: ['description', 'prompt'],
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
            tool: { type: 'string', description: 'Tool name (e.g. "Bash")' },
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
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled', 'blocked', 'deleted'], description: 'New status' },
      activeForm: { type: 'string', description: 'New active form description' },
      addBlocks: { type: 'array', items: { type: 'string' }, description: 'Task IDs this task should block' },
      removeBlocks: { type: 'array', items: { type: 'string' }, description: 'Task IDs to unblock' },
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
  TaskOutput: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The task ID to get output from' },
      block: { type: 'boolean', description: 'Wait for completion (default: true)' },
      timeout: { type: 'number', description: 'Max wait time in ms (default: 30000)' },
    },
    required: ['task_id'],
  },
  SendMessage: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient name, or "*" for broadcast' },
      message: { description: 'Message content (string or object)' },
      summary: { type: 'string', description: 'Optional summary of the message' },
    },
    required: ['to', 'message'],
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
  REPL: {
    type: 'object',
    properties: {
      operations: {
        type: 'array',
        description: 'Array of tool invocations to execute in order',
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string', description: 'Tool name' },
            input: { type: 'object', description: 'Tool input parameters' },
          },
          required: ['tool', 'input'],
        },
      },
    },
    required: ['operations'],
  },
  ScheduleCron: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'list', 'delete'], description: 'CRUD action' },
      name: { type: 'string', description: 'Job name (for create/delete)' },
      schedule: { type: 'string', description: 'Cron expression (for create)' },
      command: { type: 'string', description: 'Shell command to run (for create)' },
    },
    required: ['action'],
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
  Tungsten: {
    type: 'object',
    properties: {},
    description: 'Tungsten integration (not available in local mode).',
  },
  Workflow: {
    type: 'object',
    properties: {},
    description: 'Workflow automation (not available in local mode).',
  },
}

/** Build Anthropic tool_def objects from the dispatcher's registered tools. */
export function buildNativeToolDefs(dispatcher: ToolDispatcher) {
  return dispatcher.getToolNames()
    .filter((name) => NATIVE_TOOL_SCHEMAS[name])
    .map((name) =>
      buildToolDef(name, `Native ${name} tool`, NATIVE_TOOL_SCHEMAS[name]!),
    )
}
