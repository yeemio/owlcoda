/**
 * Common interface for all OwlCoda native tools.
 *
 * Every tool accepts a typed input, executes, and returns a ToolResult.
 */

import type { TaskExecutionState } from '../protocol/types.js'

export interface ToolResult {
  /** Main text output (shown to the model) */
  output: string
  /** Whether the tool execution succeeded */
  isError: boolean
  /** Optional structured metadata (not sent to model, used internally) */
  metadata?: Record<string, unknown>
}

/** Progress event emitted by long-running tools (e.g. bash). */
export interface ToolProgressEvent {
  /** Recent output lines (last N) */
  lines: string[]
  /** Total number of output lines so far */
  totalLines: number
  /** Total bytes of output received */
  totalBytes: number
  /** Elapsed time in ms since execution started */
  elapsedMs: number
}

/** A labelled choice offered to the user by an AskUserQuestion-style tool. */
export interface AskUserOption {
  label: string
  description?: string
}

export interface AskUserQuestionOpts {
  options?: AskUserOption[]
  /** When true the UI accepts multiple comma-separated selections. */
  multiSelect?: boolean
}

/** Context passed to tool execution — provides callbacks and cancellation. */
export interface ToolExecutionContext {
  /** Called with progress updates during long-running tool execution */
  onProgress?: (event: ToolProgressEvent) => void
  /** Abort signal for cancellation */
  signal?: AbortSignal
  /** Persistent task contract state for scoped execution. */
  taskState?: TaskExecutionState
  /**
   * Ask the user a question through the host UI. When provided, tools
   * MUST use this instead of writing prompts to stdout directly —
   * side-channel writes race Ink's frame paint (see
   * memory/feedback_ink_side_channel_stdout_race.md). Absence means the
   * host is headless/non-interactive; tools should fall back to a
   * readline-style prompt only in that case.
   *
   * Resolves with the user's raw answer string. Empty string indicates
   * the user cancelled (e.g. via Ctrl+C). Rejects only on unrecoverable
   * transport failures.
   */
  askUserQuestion?: (question: string, opts?: AskUserQuestionOpts) => Promise<string>
}

export type ToolMaturity = 'ga' | 'beta' | 'experimental'

export interface NativeToolDef<TInput> {
  /** Tool name as it appears in the Anthropic tool_use protocol */
  name: string
  /** Human-readable description */
  description: string
  /** Maturity level — defaults to 'ga' if not specified */
  maturity?: ToolMaturity
  /** Execute the tool with validated input */
  execute(input: TInput, context?: ToolExecutionContext): Promise<ToolResult>
}

/** Bash tool input */
export interface BashInput {
  command: string
  /** Working directory (defaults to process.cwd()) */
  cwd?: string
  /** Timeout in milliseconds (default 120_000) */
  timeoutMs?: number
}

/** Read tool input */
export interface ReadInput {
  path: string
  /** 1-based start line (inclusive) */
  startLine?: number
  /** 1-based end line (inclusive) */
  endLine?: number
  /** Byte offset to start reading from */
  offset?: number
  /** Maximum bytes to read */
  limit?: number
}

/** Write tool input */
export interface WriteInput {
  path: string
  content: string
  /** Create parent directories if needed (default true) */
  createDirs?: boolean
}

/** Edit tool input */
export interface EditInput {
  path: string
  oldStr: string
  newStr: string
}

/** Glob tool input */
export interface GlobInput {
  pattern: string
  /** Base directory (defaults to process.cwd()) */
  cwd?: string
  /** Exclude patterns */
  ignore?: string[]
}

/** Grep tool input */
export interface GrepInput {
  pattern: string
  /** File or directory to search */
  path?: string
  /** Glob filter for files (e.g. "*.ts") */
  include?: string
  /** Case insensitive */
  ignoreCase?: boolean
  /** Max results */
  maxResults?: number
}

/** WebFetch tool input */
export interface WebFetchInput {
  /** URL to fetch */
  url: string
  /** Optional prompt for context */
  prompt?: string
}

/** WebSearch tool input */
export interface WebSearchInput {
  /** Search query */
  query: string
  /** Max results to return */
  maxResults?: number
}

/** TodoWrite tool input */
export interface TodoWriteInput {
  /** The updated todo list */
  todos: Array<{
    content: string
    status: 'pending' | 'in_progress' | 'completed'
    activeForm: string
  }>
}

/** AskUserQuestion tool input */
export interface AskUserQuestionInput {
  question: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
}

/** Sleep tool input */
export interface SleepInput {
  /** Duration in seconds */
  durationSeconds: number
}

/** Agent tool input */
export interface AgentInput {
  /** Short 3-5 word description */
  description: string
  /** The task prompt */
  prompt: string
  /** Agent type (general-purpose or Explore) */
  subagent_type?: string
}

/** EnterPlanMode tool input (no parameters) */
export interface EnterPlanModeInput {
  // Intentionally empty — upstream accepts no parameters
}

/** ExitPlanMode tool input */
export interface ExitPlanModeInput {
  /** Optional allowedPrompts for bash permissions post-plan */
  allowedPrompts?: Array<{
    tool: string
    prompt: string
  }>
}

/** Config tool input */
export interface ConfigInput {
  /** Setting key (e.g. "theme", "model") */
  setting: string
  /** New value — omit to read current value */
  value?: string | boolean | number
}

/** NotebookEdit tool input */
export interface NotebookEditInput {
  /** Absolute path to the .ipynb notebook file */
  notebook_path: string
  /** Cell ID or cell index (e.g. "cell-3") to target */
  cell_id?: string
  /** New source content for the cell */
  new_source: string
  /** Cell type — required for insert, optional for replace */
  cell_type?: 'code' | 'markdown'
  /** Edit mode: replace (default), insert, or delete */
  edit_mode?: 'replace' | 'insert' | 'delete'
}

/** EnterWorktree tool input */
export interface EnterWorktreeInput {
  /** Optional name slug for the worktree branch */
  name?: string
}

/** ExitWorktree tool input */
export interface ExitWorktreeInput {
  /** "keep" preserves the worktree; "remove" deletes it */
  action: 'keep' | 'remove'
  /** Must be true to remove a worktree with uncommitted changes */
  discard_changes?: boolean
}
