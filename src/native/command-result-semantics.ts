export interface CommandResultSemanticEvaluation {
  success: boolean
  semanticSuccess?: boolean
  commandResultSemantics?: 'git_diff_no_index_check'
  successDetail?: string
}

export function evaluateCommandResult(input: {
  command: string
  exitCode: number
  expectedExitCode?: number
  stdout?: string
  stderr?: string
}): CommandResultSemanticEvaluation {
  const expectedExitCode = input.expectedExitCode ?? 0
  if (input.exitCode === expectedExitCode) return { success: true }

  if (
    expectedExitCode === 0
    && input.exitCode === 1
    && isGitDiffNoIndexCheck(input.command)
    && !(input.stdout ?? '').trim()
    && !(input.stderr ?? '').trim()
  ) {
    return {
      success: true,
      semanticSuccess: true,
      commandResultSemantics: 'git_diff_no_index_check',
      successDetail: 'no whitespace errors',
    }
  }

  return { success: false }
}

function isGitDiffNoIndexCheck(command: string): boolean {
  const normalized = command.trim()
  return !/[;&|<>`\r\n]/.test(normalized)
    && !/\$\(/.test(normalized)
    && !/(?:^|\s)(?:--quiet|-q|--no-patch|-s)(?:\s|$)/.test(normalized)
    && !/(?:^|\s)--output(?:=|\s)/.test(normalized)
    && /^git\s+diff\b/.test(normalized)
    && /(?:^|\s)--no-index(?:\s|$)/.test(normalized)
    && /(?:^|\s)--check(?:\s|$)/.test(normalized)
}
