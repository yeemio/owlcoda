/**
 * Shell completion script generators for owlcoda.
 * Supports bash, zsh, and fish.
 */

const COMMANDS = ['start', 'stop', 'status', 'clients', 'server', 'serve', 'run', 'doctor', 'ui', 'admin', 'init', 'config', 'models', 'logs', 'completions', 'benchmark', 'export', 'inspect', 'validate', 'health', 'audit', 'cache', 'skills']
const FLAGS = ['--port', '--config', '--router', '--model', '--daemon-only', '--prompt', '--json', '--auto-approve', '--resume', '--dry-run', '--print-url', '--open-browser', '--route', '--select', '--view', '--force', '--help', '--version']

export function generateBashCompletion(): string {
  return `# owlcoda bash completion
_owlcoda_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local commands="${COMMANDS.join(' ')}"
  local flags="${FLAGS.join(' ')}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${commands} \${flags}" -- "\${cur}") )
  else
    COMPREPLY=( $(compgen -W "\${flags}" -- "\${cur}") )
  fi
}
complete -F _owlcoda_completions owlcoda
`
}

export function generateZshCompletion(): string {
  const cmdDescs = [
    'start:Start proxy in background',
    'stop:Stop background proxy',
    'status:Check proxy status',
    'clients:List or detach live REPL clients',
    'server:Start proxy in foreground',
    'serve:Standalone API server',
    'run:Non-interactive prompt execution',
    'doctor:Diagnose environment',
    'ui:Print browser admin URL',
    'admin:Alias for ui',
    'init:Create config.json',
    'config:Show active configuration',
    'models:Show configured models',
    'logs:Show recent log entries',
    'completions:Generate shell completions',
    'benchmark:Benchmark model latency',
    'export:Export sanitized config',
    'inspect:Inspect captured exchanges',
    'validate:Validate config file',
    'health:Check proxy and router health',
    'audit:Query request audit log',
    'cache:Show or clear response cache',
    'skills:Manage learned skills (list/show/synth/delete)',
  ]
  return `#compdef owlcoda
# owlcoda zsh completion

_owlcoda() {
  local -a commands flags

  commands=(
${cmdDescs.map(d => `    '${d}'`).join('\n')}
  )

  flags=(
    '--port[Override listen port]:port:'
    '--config[Path to config file]:file:_files'
    '--router[Override router URL]:url:'
    '--model[Select model]:model:'
    '--daemon-only[Proxy daemon only]'
    '--prompt[Prompt text]:text:'
    '--json[JSON output mode]'
    '--auto-approve[Auto-approve tool executions]'
    '--resume[Resume session]:id:'
    '--dry-run[Validate without launching]'
    '--print-url[Print the admin URL without opening a browser]'
    '--open-browser[Launch the admin URL in your browser]'
    '--route[Admin browser route]:route:(models aliases orphans catalog)'
    '--select[Preselect a model in browser admin]:model:'
    '--view[Optional browser admin subview/filter]:view:'
    '--force[Force overwrite]'
    '--help[Show help]'
    '--version[Show version]'
  )

  _arguments -s \\
    '1:command:->commands' \\
    '*:flags:->flags'

  case $state in
    commands)
      _describe 'command' commands
      ;;
    flags)
      _values 'flags' $flags
      ;;
  esac
}

_owlcoda "$@"
`
}

export function generateFishCompletion(): string {
  const lines: string[] = ['# owlcoda fish completion']

  const cmdDescs: Array<[string, string]> = [
    ['start', 'Start proxy in background'],
    ['stop', 'Stop background proxy'],
    ['status', 'Check proxy status'],
    ['clients', 'List or detach live REPL clients'],
    ['server', 'Start proxy in foreground'],
    ['serve', 'Standalone API server'],
    ['run', 'Non-interactive prompt execution'],
    ['doctor', 'Diagnose environment'],
    ['ui', 'Print browser admin URL'],
    ['admin', 'Alias for ui'],
    ['init', 'Create config.json'],
    ['config', 'Show active configuration'],
    ['models', 'Show configured models'],
    ['logs', 'Show recent log entries'],
    ['completions', 'Generate shell completions'],
    ['benchmark', 'Benchmark model latency'],
    ['export', 'Export sanitized config'],
    ['inspect', 'Inspect captured exchanges'],
    ['validate', 'Validate config file'],
    ['health', 'Check proxy and router health'],
    ['audit', 'Query request audit log'],
    ['cache', 'Show or clear response cache'],
    ['skills', 'Manage learned skills'],
  ]

  for (const [cmd, desc] of cmdDescs) {
    lines.push(`complete -c owlcoda -n '__fish_use_subcommand' -a '${cmd}' -d '${desc}'`)
  }

  const flagDescs: Array<[string, string, boolean]> = [
    ['port', 'Override listen port', true],
    ['config', 'Path to config file', true],
    ['router', 'Override router URL', true],
    ['model', 'Select model', true],
    ['daemon-only', 'Proxy daemon only', false],
    ['prompt', 'Prompt text', true],
    ['json', 'JSON output mode', false],
    ['auto-approve', 'Auto-approve tool executions', false],
    ['resume', 'Resume session', true],
    ['dry-run', 'Validate without launching', false],
    ['print-url', 'Print the admin URL without opening a browser', false],
    ['open-browser', 'Launch the admin URL in your browser', false],
    ['route', 'Admin browser route', true],
    ['select', 'Preselect a model in browser admin', true],
    ['view', 'Optional browser admin subview/filter', true],
    ['force', 'Force overwrite', false],
    ['help', 'Show help', false],
    ['version', 'Show version', false],
  ]

  for (const [flag, desc, hasArg] of flagDescs) {
    const req = hasArg ? ' -r' : ''
    lines.push(`complete -c owlcoda -l '${flag}'${req} -d '${desc}'`)
  }

  return lines.join('\n') + '\n'
}

export type ShellType = 'bash' | 'zsh' | 'fish'

export function generateCompletion(shell: ShellType): string {
  switch (shell) {
    case 'bash': return generateBashCompletion()
    case 'zsh': return generateZshCompletion()
    case 'fish': return generateFishCompletion()
  }
}
