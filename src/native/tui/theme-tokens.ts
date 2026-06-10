/**
 * Authoring-surface color tokens.
 *
 * Shared by the user turn block (post-submit, in transcript) and the
 * composer panel (pre-submit, at bottom of pane) so both feel like the
 * same authoring surface in two states.
 *
 * Uses 256-color ANSI escapes for broad terminal compatibility. Avoids
 * truecolor (24-bit) for consistent appearance across emulators.
 *
 * MVP: all themes share the same palette. Per-theme variation is a
 * future-round knob (spec §6).
 */

import type { ThemeName } from './colors.js'

export interface AuthoringTokens {
  /**
   * Foreground color for the left accent bar (▎) and emphasized rail
   * text. Owl brand teal — 24-bit truecolor matching the `owl` theme
   * token used by the live composer's borderLeftColor so submit-time
   * transitions keep hue continuity.
   */
  readonly accent: string
  /**
   * Background color for the authored-content band. A heavily darkened
   * / desaturated owl: same hue family as the accent, ~33% of its
   * brightness, so the band reads as a faded teal tint rather than a
   * competing color block. Text on this bg remains high-contrast for
   * both dark and light terminal palettes.
   */
  readonly bg: string
  /**
   * ANSI reset for background only. Preserves foreground attrs.
   */
  readonly bgReset: string
  /**
   * Dim foreground for tertiary rail text (ctrl-hint, secondary status).
   * 256-color index 244 (#808080).
   */
  readonly dim: string
}

// 24-bit truecolor so the hue matches owl = rgb(92,184,196) exactly,
// not the nearest 256-color approximation. Every modern terminal in the
// test/QA matrix (Terminal.app, tmux, iTerm2, Ghostty, Alacritty, WT)
// supports 24-bit — 256-color fallback would quantize either the
// accent or the faded bg to something visibly off-hue.
const DEFAULT_TOKENS: AuthoringTokens = {
  accent: '\x1b[38;2;92;184;196m',
  bg: '\x1b[48;2;30;58;62m',
  bgReset: '\x1b[49m',
  dim: '\x1b[38;5;244m',
}

/**
 * Return the authoring tokens for a given theme. MVP returns the same
 * tokens for every theme; per-theme differentiation is a follow-up.
 */
export function authoringTokensFor(_theme: ThemeName): AuthoringTokens {
  return DEFAULT_TOKENS
}
