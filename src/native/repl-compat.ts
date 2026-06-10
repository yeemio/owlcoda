export type TranscriptInteractionEnvironment = 'tmux' | 'terminal_app' | 'iterm2' | 'other'
export type TranscriptWheelSupport = 'verified' | 'not_guaranteed' | 'unverified'

export interface TranscriptInteractionCapability {
  environment: TranscriptInteractionEnvironment
  environmentLabel: string
  selectionMode: 'selection-first'
  selectionSummary: string
  wheelSupport: TranscriptWheelSupport
  wheelSummary: string
  helpSummary: string
  startupNotice?: string
}

const SELECTION_SUMMARY =
  'Selection-first main REPL keeps terminal-native drag-select and copy on the primary screen.'

function detectTranscriptEnvironment(
  env: NodeJS.ProcessEnv,
): TranscriptInteractionEnvironment {
  if (env['TMUX']) return 'tmux'

  const terminalProgram = env['TERM_PROGRAM'] ?? ''
  const lcTerminal = env['LC_TERMINAL'] ?? ''

  if (terminalProgram === 'Apple_Terminal' || lcTerminal === 'Apple_Terminal') {
    return 'terminal_app'
  }

  if (
    terminalProgram === 'iTerm.app'
    || terminalProgram === 'iTerm2'
    || lcTerminal === 'iTerm2'
  ) {
    return 'iterm2'
  }

  return 'other'
}

export function getTranscriptInteractionCapability(
  env: NodeJS.ProcessEnv = process.env,
): TranscriptInteractionCapability {
  switch (detectTranscriptEnvironment(env)) {
    case 'tmux':
      return {
        environment: 'tmux',
        environmentLabel: 'tmux',
        selectionMode: 'selection-first',
        selectionSummary: SELECTION_SUMMARY,
        wheelSupport: 'not_guaranteed',
        wheelSummary:
          'Real tmux wheel passthrough is not guaranteed in the current primary-screen runtime.',
        helpSummary:
          'selection-first keeps terminal-native selection/copy; tmux wheel is not guaranteed, so use PgUp/PgDn, Ctrl+↓, or tmux scrollback.',
        // One-line startup notice — design spec keeps the first-screen
        // warning compact so welcome + composer still fit at 80 cols.
        // Full rationale lives in `/doctor` and `helpSummary`.
        startupNotice:
          'tmux detected: wheel partial — use PgUp/PgDn or /doctor',
      }

    case 'terminal_app':
      return {
        environment: 'terminal_app',
        environmentLabel: 'Terminal.app',
        selectionMode: 'selection-first',
        selectionSummary: SELECTION_SUMMARY,
        wheelSupport: 'verified',
        wheelSummary:
          'Terminal.app direct wheel and two-finger scroll are verified on the terminal-owned scrollback path in the current selection-first runtime.',
        helpSummary:
          'selection-first keeps terminal-native selection/copy; Terminal.app direct wheel is verified on the terminal-owned scrollback path.',
      }

    case 'iterm2':
      return {
        environment: 'iterm2',
        environmentLabel: 'iTerm2',
        selectionMode: 'selection-first',
        selectionSummary: SELECTION_SUMMARY,
        wheelSupport: 'unverified',
        wheelSummary:
          'iTerm2 wheel compatibility is not verified on this machine yet. Keep PgUp/PgDn and Ctrl+↓ as fallback.',
        helpSummary:
          'selection-first keeps terminal-native selection/copy; iTerm2 wheel is not yet verified on this machine, so keep PgUp/PgDn and Ctrl+↓ as fallback.',
      }

    default:
      return {
        environment: 'other',
        environmentLabel: 'terminal',
        selectionMode: 'selection-first',
        selectionSummary: SELECTION_SUMMARY,
        wheelSupport: 'unverified',
        wheelSummary:
          'Wheel passthrough depends on the terminal and multiplexer. Keep PgUp/PgDn and Ctrl+↓ as the stable in-app scroll path.',
        helpSummary:
          'selection-first keeps terminal-native selection/copy; wheel passthrough depends on the terminal, so keep PgUp/PgDn and Ctrl+↓ as fallback.',
      }
  }
}
