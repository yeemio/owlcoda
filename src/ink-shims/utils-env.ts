// Minimal env.ts — only exports the env object for ink/ terminal detection
function detectTerminal(): string | undefined {
  const tp = process.env['TERM_PROGRAM']
  if (tp === 'Apple_Terminal') return 'Apple_Terminal'
  if (process.env['KITTY_WINDOW_ID'] || tp === 'kitty') return 'kitty'
  if (tp === 'iTerm.app') return 'iTerm.app'
  if (tp === 'ghostty') return 'ghostty'
  if (tp === 'WezTerm') return 'WezTerm'
  return tp || undefined
}

export const env: Record<string, string | undefined> = {
  terminal: detectTerminal(),
  TERM_PROGRAM: process.env['TERM_PROGRAM'],
  TERM: process.env['TERM'],
  COLORTERM: process.env['COLORTERM'],
  KITTY_WINDOW_ID: process.env['KITTY_WINDOW_ID'],
  ConEmuPID: process.env['ConEmuPID'],
  ConEmuANSI: process.env['ConEmuANSI'],
  ConEmuTask: process.env['ConEmuTask'],
  MSYSTEM: process.env['MSYSTEM'],
  WT_SESSION: process.env['WT_SESSION'],
  OWLCODA_ACCESSIBILITY: process.env['OWLCODA_ACCESSIBILITY'],
  OWLCODA_DEBUG_REPAINTS: process.env['OWLCODA_DEBUG_REPAINTS'],
  OWLCODA_COMMIT_LOG: process.env['OWLCODA_COMMIT_LOG'],
  OWLCODA_TMUX_TRUECOLOR: process.env['OWLCODA_TMUX_TRUECOLOR'],
}
