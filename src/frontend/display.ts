/**
 * Terminal display utilities for OwlCoda native REPL.
 * Zero runtime dependencies — uses only Node.js built-ins.
 */

// ANSI color codes
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const MAGENTA = '\x1b[35m'

export function colorize(text: string, color: string): string {
  return `${color}${text}${RESET}`
}

export function bold(text: string): string {
  return `${BOLD}${text}${RESET}`
}

export function dim(text: string): string {
  return `${DIM}${text}${RESET}`
}

export function formatModelName(model: string): string {
  return colorize(model, CYAN)
}

export function formatToolCall(name: string, input: Record<string, unknown>): string {
  const lines: string[] = []
  lines.push(colorize(`  ⚙ Tool: ${name}`, MAGENTA))
  const inputStr = JSON.stringify(input, null, 2)
  const inputLines = inputStr.split('\n')
  if (inputLines.length <= 5) {
    lines.push(dim(`    ${inputStr}`))
  } else {
    for (const line of inputLines.slice(0, 4)) {
      lines.push(dim(`    ${line}`))
    }
    lines.push(dim(`    ... (${inputLines.length - 4} more lines)`))
  }
  return lines.join('\n')
}

export function formatToolResult(name: string, isError: boolean): string {
  if (isError) {
    return colorize(`  ✗ Tool ${name} failed`, RED)
  }
  return colorize(`  ✓ Tool ${name} completed`, GREEN)
}

export function formatUsage(inputTokens: number, outputTokens: number): string {
  return dim(`[${inputTokens} in / ${outputTokens} out tokens]`)
}

export function formatStopReason(reason: string): string {
  switch (reason) {
    case 'end_turn': return ''
    case 'max_tokens': return dim(' (truncated: max tokens)')
    case 'stop_sequence': return dim(' (stop sequence)')
    case 'tool_use': return ''
    default: return dim(` (${reason})`)
  }
}

export interface PreflightStatus {
  name: string
  status: 'healthy' | 'missing' | 'degraded'
  detail: string
}

export function formatPreflightResults(results: PreflightStatus[]): string {
  const lines: string[] = [bold('Platform preflight:')]
  for (const r of results) {
    let icon: string
    let color: string
    switch (r.status) {
      case 'healthy':
        icon = '✓'
        color = GREEN
        break
      case 'degraded':
        icon = '⚠'
        color = YELLOW
        break
      case 'missing':
        icon = '✗'
        color = RED
        break
    }
    lines.push(`  ${color}${icon}${RESET} ${r.name}: ${r.detail}`)
  }
  return lines.join('\n')
}

export function formatBanner(version: string, model: string, capabilities: string[]): string {
  const lines: string[] = [
    '',
    bold(`OwlCoda v${version}`) + ' — Local model platform front door',
    `  Model: ${formatModelName(model)}`,
    `  Mode:  native local (no cloud dependency)`,
    '',
  ]
  if (capabilities.length > 0) {
    lines.push(dim('  Capabilities: ' + capabilities.join(', ')))
    lines.push('')
  }
  lines.push(dim('  Type /help for commands, /quit to exit'))
  lines.push('')
  return lines.join('\n')
}

export function formatError(message: string): string {
  return colorize(`Error: ${message}`, RED)
}

export function formatWarning(message: string): string {
  return colorize(`Warning: ${message}`, YELLOW)
}

export function formatInfo(message: string): string {
  return dim(message)
}
