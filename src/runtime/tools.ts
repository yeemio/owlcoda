/**
 * OwlCoda local tool execution runtime.
 *
 * Supports: Bash, Read, Write, Glob.
 * Safety: Bash requires confirmation for dangerous patterns, file write requires confirmation,
 * all operations have timeouts and output truncation.
 *
 * ─── Lifecycle status (issue #4, 2026-04-26) ────────────────────────────
 *
 *   STATUS: legacy / not reachable from production.
 *
 *   Production CLI binary route is `cli.ts → cli-core.ts → native/repl.ts`
 *   and `native/headless.ts`. Neither imports anything from this file.
 *   The only consumer of `executeToolUse` / `TOOL_DEFINITIONS` is
 *   `src/frontend/repl.ts`, which is itself not imported by any
 *   production entry point. See the import-boundary regression test in
 *   `tests/runtime-tools-boundary.test.ts` — that test will fail loudly
 *   if a future change wakes this path back up without going through the
 *   centralized policies.
 *
 *   The bash dangerous-pattern check below has been bridged to the
 *   centralized `classifyBashCommand()` in `src/native/bash-risk.ts`
 *   (issue #2). Even if a future caller revives this file, `bash` will
 *   inherit the same risk taxonomy as the native dispatcher.
 *
 *   New work should NOT add features here. Either implement in
 *   `src/native/tools/*` (production path) or document a follow-up that
 *   either retires this file or re-bridges it to the native dispatcher.
 */

import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve, isAbsolute, normalize } from 'node:path'
import { classifyBashCommand } from '../native/bash-risk.js'

// ─── Types ───

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ToolResult {
  toolUseId: string
  content: string
  isError: boolean
}

export type ApprovalCallback = (tool: string, detail: string) => Promise<boolean>

export interface ToolExecutorConfig {
  /** Working directory for tool execution */
  cwd: string
  /** Maximum execution time for bash commands (ms) */
  bashTimeoutMs: number
  /** Maximum output length before truncation (chars) */
  maxOutputChars: number
  /** Callback for approval before dangerous operations */
  approve: ApprovalCallback
  /** Auto-approve all operations (non-interactive mode) */
  autoApprove: boolean
}

const DEFAULT_CONFIG: ToolExecutorConfig = {
  cwd: process.cwd(),
  bashTimeoutMs: 30_000,
  maxOutputChars: 10_000,
  approve: async () => false,
  autoApprove: false,
}

// ─── Path boundary ───

/**
 * Check if a resolved absolute path is within the workspace (cwd).
 * Returns true if pathToCheck starts with cwd prefix.
 */
export function isWithinWorkspace(pathToCheck: string, cwd: string): boolean {
  const normalizedPath = normalize(pathToCheck)
  const normalizedCwd = normalize(cwd)
  // Ensure cwd ends with separator for prefix match
  const cwdPrefix = normalizedCwd.endsWith('/') ? normalizedCwd : normalizedCwd + '/'
  return normalizedPath === normalizedCwd || normalizedPath.startsWith(cwdPrefix)
}

// ─── Safety patterns ───

/**
 * Legacy bridge — historical `DANGEROUS_BASH_PATTERNS` regex list is now
 * delegated to the centralized `classifyBashCommand()` so this file and
 * the native path can never disagree about what counts as dangerous
 * (issue #2).
 *
 * Behavioral note: the original list flagged a few `needs_approval`-class
 * commands as "dangerous" (notably `git reset --hard`, `git clean -fd`,
 * `git push --force`, kill family). The classifier still treats these
 * as `dangerous`, so the bridge preserves the intent. Other historical
 * "needs approval" cases that the legacy regex didn't cover (e.g.
 * `mv`, `rm` without -rf) now correctly trip the prompt as well, which
 * makes the legacy runtime *stricter*, never more permissive.
 */
function isDangerousBash(command: string): boolean {
  return classifyBashCommand(command).level === 'dangerous'
}

function truncateOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output
  const half = Math.floor(maxChars / 2) - 50
  return output.slice(0, half) + `\n\n... [truncated ${output.length - maxChars} chars] ...\n\n` + output.slice(-half)
}

// ─── Bash executor ───

async function executeBash(
  input: { command: string },
  config: ToolExecutorConfig,
): Promise<{ output: string; isError: boolean }> {
  const { command } = input
  if (!command || typeof command !== 'string') {
    return { output: 'Error: "command" field is required and must be a string', isError: true }
  }

  // Safety check
  if (isDangerousBash(command) && !config.autoApprove) {
    const approved = await config.approve('Bash', `Potentially dangerous command:\n  $ ${command}`)
    if (!approved) {
      return { output: 'Command rejected by user', isError: true }
    }
  } else if (!config.autoApprove) {
    const approved = await config.approve('Bash', `$ ${command}`)
    if (!approved) {
      return { output: 'Command rejected by user', isError: true }
    }
  }

  return new Promise(resolve => {
    let timedOut = false
    const child = spawn('bash', ['-c', command], {
      cwd: config.cwd,
      env: { ...process.env, TERM: 'dumb' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Kill child on timeout (Node.js timeout option doesn't kill the process tree)
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already dead */ } }, 2000)
    }, config.bashTimeoutMs)

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      let output = stdout
      if (stderr) {
        output += (output ? '\n' : '') + stderr
      }
      output = truncateOutput(output, config.maxOutputChars)

      if (timedOut) {
        resolve({ output: output || `Command timed out after ${config.bashTimeoutMs}ms`, isError: true })
      } else if (code !== 0) {
        output = output || `Command exited with code ${code}`
        resolve({ output, isError: true })
      } else {
        resolve({ output: output || '(no output)', isError: false })
      }
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ output: `Execution error: ${err.message}`, isError: true })
    })
  })
}

// ─── Read executor ───

async function executeRead(
  input: { file_path: string },
  config: ToolExecutorConfig,
): Promise<{ output: string; isError: boolean }> {
  const { file_path } = input
  if (!file_path || typeof file_path !== 'string') {
    return { output: 'Error: "file_path" field is required', isError: true }
  }

  const absPath = isAbsolute(file_path) ? file_path : resolve(config.cwd, file_path)

  // Workspace boundary: paths outside cwd require approval
  if (!isWithinWorkspace(absPath, config.cwd) && !config.autoApprove) {
    const approved = await config.approve('Read', `File outside workspace: ${absPath}`)
    if (!approved) {
      return { output: `Read rejected: ${absPath} is outside workspace (${config.cwd})`, isError: true }
    }
  }

  try {
    const content = await readFile(absPath, 'utf-8')
    return { output: truncateOutput(content, config.maxOutputChars), isError: false }
  } catch (err) {
    return { output: `Error reading ${absPath}: ${(err as Error).message}`, isError: true }
  }
}

// ─── Write executor ───

async function executeWrite(
  input: { file_path: string; content: string },
  config: ToolExecutorConfig,
): Promise<{ output: string; isError: boolean }> {
  const { file_path, content } = input
  if (!file_path || typeof file_path !== 'string') {
    return { output: 'Error: "file_path" field is required', isError: true }
  }
  if (content === undefined || content === null) {
    return { output: 'Error: "content" field is required', isError: true }
  }

  const absPath = isAbsolute(file_path) ? file_path : resolve(config.cwd, file_path)

  // Safety: require approval for file writes (extra warning if outside workspace)
  if (!config.autoApprove) {
    const exists = existsSync(absPath)
    const outsideNote = !isWithinWorkspace(absPath, config.cwd) ? ' [OUTSIDE WORKSPACE]' : ''
    const detail = exists
      ? `Overwrite existing file${outsideNote}: ${absPath} (${String(content).length} chars)`
      : `Create new file${outsideNote}: ${absPath} (${String(content).length} chars)`
    const approved = await config.approve('Write', detail)
    if (!approved) {
      return { output: 'Write rejected by user', isError: true }
    }
  }

  try {
    const dir = dirname(absPath)
    await mkdir(dir, { recursive: true })
    await writeFile(absPath, String(content), 'utf-8')
    return { output: `Wrote ${String(content).length} chars to ${absPath}`, isError: false }
  } catch (err) {
    return { output: `Error writing ${absPath}: ${(err as Error).message}`, isError: true }
  }
}

// ─── Glob executor ───

async function executeGlob(
  input: { pattern: string; path?: string },
  config: ToolExecutorConfig,
): Promise<{ output: string; isError: boolean }> {
  const { pattern, path: searchPath } = input
  if (!pattern || typeof pattern !== 'string') {
    return { output: 'Error: "pattern" field is required', isError: true }
  }

  const cwd = searchPath ? (isAbsolute(searchPath) ? searchPath : resolve(config.cwd, searchPath)) : config.cwd

  // Workspace boundary: glob outside cwd requires approval
  if (!isWithinWorkspace(cwd, config.cwd) && !config.autoApprove) {
    const approved = await config.approve('Glob', `Search outside workspace: ${cwd}`)
    if (!approved) {
      return { output: `Glob rejected: ${cwd} is outside workspace (${config.cwd})`, isError: true }
    }
  }

  // Use find command as fallback since Node.js glob is async/complex
  return new Promise(resolve => {
    const child = spawn('bash', ['-c', `find ${JSON.stringify(cwd)} -maxdepth 5 -name ${JSON.stringify(pattern)} 2>/dev/null | head -100`], {
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8') })

    child.on('close', () => {
      const trimmed = stdout.trim()
      if (!trimmed) {
        resolve({ output: `No files matching "${pattern}" found`, isError: false })
      } else {
        resolve({ output: truncateOutput(trimmed, config.maxOutputChars), isError: false })
      }
    })

    child.on('error', (err) => {
      resolve({ output: `Glob error: ${err.message}`, isError: true })
    })
  })
}

// ─── Tool registry ───

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'Bash',
    description: 'Execute a bash command in the local shell',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
      },
      required: ['command'],
    },
  },
  {
    name: 'Read',
    description: 'Read the contents of a file',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file to read (absolute or relative to cwd)' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: 'Write content to a file (creates parent dirs if needed)',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file to write' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Glob',
    description: 'Find files matching a name pattern',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Filename glob pattern (e.g., "*.ts")' },
        path: { type: 'string', description: 'Directory to search in (optional, defaults to cwd)' },
      },
      required: ['pattern'],
    },
  },
]

export const SUPPORTED_TOOLS = new Set(TOOL_DEFINITIONS.map(t => t.name))

/**
 * Execute a tool by name with the given input.
 */
export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  config: Partial<ToolExecutorConfig> = {},
): Promise<{ output: string; isError: boolean }> {
  const cfg: ToolExecutorConfig = { ...DEFAULT_CONFIG, ...config }

  switch (toolName) {
    case 'Bash':
      return executeBash(input as { command: string }, cfg)
    case 'Read':
      return executeRead(input as { file_path: string }, cfg)
    case 'Write':
      return executeWrite(input as { file_path: string; content: string }, cfg)
    case 'Glob':
      return executeGlob(input as { pattern: string; path?: string }, cfg)
    default:
      return { output: `Unknown tool: ${toolName}. Supported: ${[...SUPPORTED_TOOLS].join(', ')}`, isError: true }
  }
}

/**
 * Execute a tool_use block and return a tool_result block.
 */
export async function executeToolUse(
  toolUse: { id: string; name: string; input: Record<string, unknown> },
  config: Partial<ToolExecutorConfig> = {},
): Promise<ToolResult> {
  const { output, isError } = await executeTool(toolUse.name, toolUse.input, config)
  return {
    toolUseId: toolUse.id,
    content: output,
    isError,
  }
}
