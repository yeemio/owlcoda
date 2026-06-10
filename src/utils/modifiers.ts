export type ModifierKey = 'shift' | 'command' | 'control' | 'option'

let prewarmed = false

/**
 * Pre-warm the native module by loading it in advance.
 * Call this early to avoid delay on first use.
 */
export function prewarmModifiers(): void {
  if (prewarmed || process.platform !== 'darwin') {
    return
  }
  prewarmed = true
  // Load module in background
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { prewarm } = require('modifiers-napi') as { prewarm: () => void }
    prewarm()
  } catch {
    // Ignore errors during prewarm
  }
}

/**
 * Check if a specific modifier key is currently pressed (synchronous).
 */
export function isModifierPressed(modifier: ModifierKey): boolean {
  if (process.platform !== 'darwin') {
    return false
  }
  // The native addon `modifiers-napi` is optional and may not be installed/
  // built. This runs on the critical Enter path for Apple_Terminal (see
  // useTextInput.handleEnter), so a missing module or a failing native call
  // must NEVER escape as a throw — that would crash the whole REPL the moment
  // the user presses Enter. Degrade to "not pressed" so the caller falls
  // through to its normal submit path. (Mirrors prewarmModifiers above.)
  try {
    // Dynamic import to avoid loading native module at top level
    const { isModifierPressed: nativeIsModifierPressed } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('modifiers-napi') as { isModifierPressed: (m: string) => boolean }
    return nativeIsModifierPressed(modifier)
  } catch {
    return false
  }
}
