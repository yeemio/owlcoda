/**
 * OwlCoda TUI — Terminal User Interface Engine
 *
 * Imperative ANSI-based rendering for the native REPL.
 * Architecture: direct string building → stdout.
 * No React, no Ink, no virtual DOM — every byte is ours.
 */

// Colors, themes, and ANSI primitives
export {
  sgr, fg, bg, fg256, bg256, fgBasic, bgBasic,
  colorize, bold, dim, italic, underline, strikethrough,
  parseRgb, parseHex, resolveColor, resolveBgColor,
  stripAnsi, visibleWidth,
  getTheme, getThemeName, setTheme, resolveThemeSetting,
  themeColor, themeBg, themed,
  THEME_NAMES,
  type OwlTheme, type ThemeName, type ThemeSetting,
} from './colors.js'

// Authoring-surface tokens (user block + composer)
export { authoringTokensFor } from './theme-tokens.js'
export type { AuthoringTokens } from './theme-tokens.js'

// User turn block (authored panel rendering)
export { renderUserBlock } from './user-block.js'

// Composer panel (React frame shared by input / slash picker / permission modes)
export { ComposerInputChrome, ComposerPanel, parseInputAttachments } from './composer.js'
export type { ComposerInputChromeProps, ComposerPanelProps, ComposerAttachment } from './composer.js'

// Fullscreen-first redesign primitives
export {
  renderToolRow,
  type ToolRowOptions,
  type ToolRowState,
} from './tool-row.js'
export {
  renderBanner,
  type BannerAction,
  type BannerKind,
  type BannerOptions,
} from './banner.js'
export {
  renderMcpPanel,
  renderSessionInfoPanel,
  renderSessionsPanel,
  renderSettingsPanel,
  type McpPanelServer,
  type SessionPanelItem,
  type SettingsPanelOptions,
} from './panel.js'
export {
  PermissionCard,
  type PermissionCardChoice,
  type PermissionCardProps,
  type PermissionKind,
} from './permission-card.js'

// Text utilities
export {
  truncate, truncateMiddle,
  wordWrap, hardWrap,
  padRight, padLeft, center, repeat,
} from './text.js'

// Box drawing
export {
  renderBox, renderSeparator, renderDivider, renderColumns,
  BORDER_STYLES, HEAVY_LINE, LIGHT_LINE, DOUBLE_LINE,
  type BoxOptions, type BorderChars, type BorderStyleName,
} from './box.js'

// Spinner
export {
  Spinner, VerbSpinner, ToolUseLoader, withSpinner, withVerbSpinner,
  randomVerb, interpolateRgb,
  SPINNER_GLYPHS, OWL_VERBS,
  type SpinnerOptions, type SpinnerStyle,
  type VerbSpinnerOptions,
} from './spinner.js'

// Diff display
export {
  createUnifiedDiff, formatDiffLines, renderDiffBox, renderFileCreate,
  renderChangeBlockLines, renderFileCreateLines, countDiffStats,
  type DiffLine, type ChangeBlockOptions,
} from './diff.js'

// Permission prompts
export {
  renderPermissionDialog, renderInlinePermission,
  renderTopBorderDialog, renderBashPermission, renderFilePermission, renderWebPermission,
  type PermissionDialogOptions, type PermissionChoice,
  type TopBorderDialogOptions,
} from './permission.js'

// Welcome banner
export {
  renderWelcome,
  renderOnboardingHero,
  formatWelcomeMarker,
  getWelcomeTitleIconPlacement,
  hasTitleIconAsset,
  readWelcomeMarkerOptions,
  supportsTerminalImages,
  type WelcomeOptions, type LayoutMode, type LogoFrame, type WelcomeMarkerOptions, type WelcomeTitleIconPlacement,
} from './welcome.js'

// History search (Ctrl+R)
export {
  HistorySearch,
  type HistorySearchState,
} from './history-search.js'

// Interactive fuzzy picker
export {
  showPicker, fuzzyMatch, highlightMatch, isReadlinePickerSettling, resetReadlineInputState,
  registerPickerIsolation, __getPickerIsolationForTests,
  type PickerIsolationHooks,
  type PickerItem, type PickerOptions, type PickerResult,
} from './picker.js'
export {
  buildFilePickerItems,
  type FilePickerOptions,
} from './file-picker.js'

// Message & tool display
export {
  formatToolUseHeader, formatToolResult, formatToolResultBox, formatToolProgress,
  formatChangeBlockResult,
  type ChangeAction, type ChangeBlockResultOptions,
  formatPromptDock,
  renderPromptDockFrame,
  renderPromptDockInputLine,
  formatPrompt, formatUserMessage, formatAssistantHeader, formatThinking, formatSystemMessage,
  formatMarker, type MarkerKind,
  formatErrorMessage, formatErrorBox,
  formatTokenUsage, formatStopReason, formatIterations,
  formatKeyHint, formatRateLimitCountdown,
  renderStatusBar,
  PersistentStatusBar,
  ToolResultCollector,
  type PromptDockFrame, type PromptDockFrameOptions,
  type StatusBarOptions,
} from './message.js'
