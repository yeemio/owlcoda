/**
 * OwlCoda native REPL compatibility surface.
 *
 * The interactive runtime now lives in `ink-repl.tsx`, aligned to the
 * upstream single-owner prompt model. This module keeps the public exports
 * used by tests and callers stable.
 */

import { startInkRepl } from './ink-repl.js'
import type { ReplOptions } from './slash-commands.js'

export {
  handleSlashCommand,
  SLASH_COMMANDS,
  safeRender,
  parseApiError,
  type ApproveState,
  type ThinkingState,
  type ReplOptions,
} from './slash-commands.js'

export {
  getTranscriptInteractionCapability,
  type TranscriptInteractionCapability,
  type TranscriptInteractionEnvironment,
  type TranscriptWheelSupport,
} from './repl-compat.js'

export {
  applyTranscriptScrollDelta,
  buildInlineStatusLine,
  buildOcLoaderFrame,
  buildOcWorkingIndicatorLines,
  buildPromptBufferRows,
  buildSlashPickerItems,
  decideFailedContinuationSubmitAction,
  classifyResolvedInput,
  composeAssistantChunk,
  composeBufferedInput,
  countTranscriptLines,
  createSyntheticLineSuppression,
  detectBufferedInputSignals,
  detectInputSignals,
  estimateWrappedLineCount,
  formatContinuationRetryStatus,
  formatRepeatedContinuationRetryGuidance,
  formatResumeCommand,
  isContinuationRetryInput,
  isRetryEligibleContinuationFailure,
  shouldDrainQueuedInputAfterTurn,
  shouldQueueSubmitBehindRunningTask,
  shouldScheduleRuntimeAutoRetry,
  parseSgrWheelDelta,
  preflightCheck,
  buildScrollIndicatorBar,
  stripBufferedMouseArtifacts,
  stripSgrMouseArtifacts,
  selectVisibleTranscriptItems,
  selectVisibleTranscriptWindow,
  shouldIgnoreSyntheticLine,
  shouldOpenSlashPickerOnKeypress,
  shouldSuppressReadlineRefresh,
  slashCompleter,
  splitTranscriptForScrollback,
  stripModifiedEnterArtifacts,
  reconcileTranscriptScrollOffset,
  scrubPseudoToolCall,
  SLASH_COMMANDS_REQUIRING_ARGS,
  type AnchorTier,
  type BufferedInputSignalState,
  type BufferedMouseArtifactState,
  type ComposeState,
  type FailedContinuationSubmitAction,
  type InputSignalState,
  type PromptBufferRow,
  type SplitTranscriptResult,
  type SyntheticLineSuppression,
  type TranscriptItem,
} from './repl-shared.js'

export async function startRepl(opts: ReplOptions): Promise<void> {
  await startInkRepl(opts)
}
