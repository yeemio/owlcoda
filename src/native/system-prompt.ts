/**
 * OwlCoda Native System Prompt Builder
 *
 * Constructs a context-aware system prompt for the native REPL and headless modes.
 * Includes CWD, OS info, available tools, and project context.
 */

import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'

export interface SystemPromptOptions {
  /** Override working directory (default: process.cwd()) */
  cwd?: string
  /** Additional context to append */
  extraContext?: string
  /** Whether to include tool descriptions (default: true) */
  includeToolDescriptions?: boolean
  /** Response mode flags (brief, fast, effort) */
  modes?: {
    brief?: boolean
    fast?: boolean
    effort?: 'low' | 'medium' | 'high'
  }
}

/** Build a system prompt with environment context. */
export function buildSystemPrompt(opts?: SystemPromptOptions): string {
  const cwd = opts?.cwd ?? process.cwd()
  const includeTools = opts?.includeToolDescriptions ?? true

  const sections: string[] = [
    CORE_IDENTITY,
    buildEnvironmentSection(cwd),
  ]

  if (includeTools) {
    sections.push(TOOL_GUIDELINES)
  }

  sections.push(BEHAVIORAL_RULES)

  // Load project memory files (OWLCODA.md)
  const memoryContent = loadProjectMemory(cwd)
  if (memoryContent) {
    sections.push(memoryContent)
  }

  // Inject mode flags so the model adapts its behavior
  if (opts?.modes) {
    const modeHints: string[] = []
    if (opts.modes.brief) {
      modeHints.push('The user has enabled BRIEF mode. Keep responses short and concise — aim for under 4 sentences per reply. Omit pleasantries, skip explanations unless asked.')
    }
    if (opts.modes.fast) {
      modeHints.push('The user has enabled FAST mode. Prioritize speed over thoroughness. Give quick answers, skip verification steps, use fewer tool calls.')
    }
    if (opts.modes.effort && opts.modes.effort !== 'medium') {
      const effortDesc = opts.modes.effort === 'low'
        ? 'Use minimal effort — quick answers, no deep investigation.'
        : 'Use maximum effort — be thorough, investigate deeply, verify results.'
      modeHints.push(`Effort level: ${opts.modes.effort}. ${effortDesc}`)
    }
    if (modeHints.length > 0) {
      sections.push('<response_mode>\n' + modeHints.join('\n') + '\n</response_mode>')
    }
  }

  if (opts?.extraContext) {
    sections.push(opts.extraContext)
  }

  return sections.join('\n\n')
}

const CORE_IDENTITY = `You are OwlCoda, an AI coding assistant running locally. You help with software engineering tasks: reading and writing code, running commands, searching files, and explaining concepts.

You have access to a comprehensive set of tools including bash, read, write, edit, glob, grep, web-fetch, web-search, and more. Use them to interact with the user's file system and execute commands.`

function buildEnvironmentSection(cwd: string): string {
  const platform = os.platform()
  const osName = platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform
  const dirName = path.basename(cwd)

  const lines = [
    `<environment>`,
    `Working directory: ${cwd}`,
    `OS: ${osName} (${os.arch()})`,
    `Shell: ${process.env.SHELL ?? 'unknown'}`,
  ]

  // Detect project type from files in CWD
  const projectHints = detectProjectType(cwd)
  if (projectHints) {
    lines.push(`Project: ${dirName} — ${projectHints}`)
  }

  // Detect git repo and current branch
  const gitBranch = getGitBranch(cwd)
  if (gitBranch) {
    lines.push(`Git: ${gitBranch}`)
  } else if (isGitRepo(cwd)) {
    lines.push(`Git: yes`)
  }

  lines.push(`</environment>`)
  return lines.join('\n')
}

/** Get the current git branch name, or null if not in a git repo. */
function getGitBranch(cwd: string): string | null {
  try {
    // Read .git/HEAD for branch — fast, no subprocess
    let dir = cwd
    for (let i = 0; i < 10; i++) {
      const headFile = path.join(dir, '.git', 'HEAD')
      if (fs.existsSync(headFile)) {
        const head = fs.readFileSync(headFile, 'utf-8').trim()
        if (head.startsWith('ref: refs/heads/')) {
          return head.slice('ref: refs/heads/'.length)
        }
        // Detached HEAD — return short SHA
        return head.slice(0, 8) + ' (detached)'
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // ignore
  }
  return null
}

const TOOL_GUIDELINES = `<tool_guidelines>
## Tool usage rules

- Use "read" to view file contents before editing. Never edit blind.
- Use "edit" for precise string replacements. The oldStr must match exactly one occurrence.
- Use "write" for creating new files or full rewrites.
- Use "bash" to run commands, build, test, and explore. Check output before continuing.
- Use "glob" to find files by name pattern (e.g. "**/*.ts").
- Use "grep" to search file contents by regex pattern.
- Use "web-fetch" to retrieve web page contents.
- Use "web-search" to search the web for information.
- Prefer reading files and running commands over making assumptions.

## CRITICAL: Always produce text between tool calls

- After EVERY tool call or group of tool calls, you MUST produce a text response before requesting more tools.
- NEVER chain multiple tool calls without any text output in between.
- After reading files, briefly state what you found and what you plan to do next.
- After running commands, report the result before proceeding.
- If you need to read multiple files, read them in ONE tool call batch, then summarize findings in text.
- The system will detect and terminate sessions where you request tools repeatedly without producing any text output.

## Efficiency rules

- Read only the files you actually need. Don't read every file in a directory.
- Use "grep" or "glob" to find relevant files before reading them.
- Keep tool output processing focused — don't request the same information twice.
- If a search returns too many results, narrow it down before reading individual files.
</tool_guidelines>`

const DOING_TASKS = `# Doing tasks
- The user will primarily request you to perform software engineering tasks: solving bugs, adding features, refactoring code, explaining code, and more.
- In general, do not propose changes to code you haven't read. Read the file first.
- Do not create files unless absolutely necessary. Prefer editing existing files.
- If an approach fails, diagnose why before switching tactics. Don't retry the identical action blindly.
- Be careful not to introduce security vulnerabilities (command injection, XSS, SQL injection).
- Don't add features, refactor, or make "improvements" beyond what was asked.
- Don't add error handling for scenarios that can't happen. Only validate at system boundaries.
- Don't create helpers or abstractions for one-time operations.`

const EXECUTING_ACTIONS = `# Executing actions with care
- Carefully consider the reversibility and blast radius of actions.
- For destructive operations (deleting files/branches, dropping tables, rm -rf), check with the user first.
- For hard-to-reverse operations (force-pushing, git reset --hard, removing packages), confirm first.
- For actions visible to others (pushing code, creating PRs, sending messages), confirm first.
- When you encounter an obstacle, do not use destructive actions as a shortcut.
- If you discover unexpected state, investigate before deleting or overwriting.`

const USING_TOOLS = `# Using your tools
- Do NOT use bash to run commands when a dedicated tool is provided:
  - To read files use "read" instead of cat/head/tail
  - To edit files use "edit" instead of sed/awk
  - To create files use "write" instead of cat with heredoc
  - To search for files use "glob" instead of find
  - To search file contents use "grep" instead of grep/rg
- You can call multiple tools in a single response. Make independent calls in parallel.
- If tool calls depend on previous results, call them sequentially.`

const OUTPUT_EFFICIENCY = `# Output efficiency
IMPORTANT: Go straight to the point. Try the simplest approach first. Be extra concise.

Keep text output brief and direct. Lead with the answer or action, not the reasoning. Skip filler words and preamble. Do not restate what the user said.

Focus text output on:
- Decisions that need the user's input
- High-level status updates at natural milestones
- Errors or blockers that change the plan

If you can say it in one sentence, don't use three.`

const TONE_AND_STYLE = `# Tone and style
- Only use emojis if the user explicitly requests it.
- Your responses should be short and concise.
- When referencing code, include file_path:line_number pattern.
- Do not use a colon before tool calls.
- Use proper markdown formatting: code blocks with language tags, headers, lists.`

const BEHAVIORAL_RULES = `${DOING_TASKS}

${EXECUTING_ACTIONS}

${USING_TOOLS}

${OUTPUT_EFFICIENCY}

${TONE_AND_STYLE}`

/** Detect project type from files in the working directory. */
function detectProjectType(cwd: string): string | null {
  const indicators: Array<[string, string]> = [
    ['package.json', 'Node.js/TypeScript'],
    ['Cargo.toml', 'Rust'],
    ['go.mod', 'Go'],
    ['pyproject.toml', 'Python'],
    ['requirements.txt', 'Python'],
    ['Gemfile', 'Ruby'],
    ['pom.xml', 'Java (Maven)'],
    ['build.gradle', 'Java (Gradle)'],
    ['CMakeLists.txt', 'C/C++ (CMake)'],
    ['Makefile', 'Make-based build'],
  ]

  const found: string[] = []
  for (const [file, label] of indicators) {
    try {
      fs.accessSync(path.join(cwd, file), fs.constants.F_OK)
      found.push(label)
    } catch {
      // not present
    }
  }

  return found.length > 0 ? found.join(', ') : null
}

/** Check if the directory is inside a git repo. */
function isGitRepo(cwd: string): boolean {
  try {
    let dir = cwd
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(path.join(dir, '.git'))) return true
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // ignore
  }
  return false
}

/** Max bytes to read from a single memory file (16KB). */
const MAX_MEMORY_FILE_BYTES = 16 * 1024

/**
 * Load project memory files (OWLCODA.md, .owlcoda/OWLCODA.md).
 * These provide persistent OwlCoda project context.
 * Searches from cwd up to the git root (or 5 levels).
 */
function loadProjectMemory(cwd: string): string | null {
  const candidates = [
    'OWLCODA.md',
    '.owlcoda/OWLCODA.md',
  ]

  const found: Array<{ name: string; content: string }> = []
  const seen = new Set<string>()

  // Search from cwd upward to git root
  let dir = cwd
  for (let depth = 0; depth < 6; depth++) {
    for (const candidate of candidates) {
      const filePath = path.join(dir, candidate)
      if (seen.has(filePath)) continue
      seen.add(filePath)

      try {
        const stat = fs.statSync(filePath)
        if (!stat.isFile() || stat.size === 0) continue
        const content = fs.readFileSync(filePath, 'utf-8').slice(0, MAX_MEMORY_FILE_BYTES).trim()
        if (content) {
          const label = depth === 0 ? candidate : path.relative(cwd, filePath)
          found.push({ name: label, content })
        }
      } catch {
        // Not found or not readable
      }
    }

    // Stop at git root or filesystem root
    if (fs.existsSync(path.join(dir, '.git'))) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  if (found.length === 0) return null

  const parts = found.map((f) =>
    `<project_instructions source="${f.name}">\n${f.content}\n</project_instructions>`,
  )
  return parts.join('\n\n')
}
