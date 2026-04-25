import { createContext, useContext } from 'react'

/**
 * Minimal public surface the React tree needs from the Ink Instance.
 * Keep narrow — expanding this is a design decision, not a convenience.
 */
export interface InkInstanceHandle {
  /**
   * Queue lines to be committed to terminal scrollback on the next
   * render. Safe to call from useLayoutEffect — this only mutates an
   * in-memory queue and schedules a re-render. Actual stdout emission
   * happens inside writeDiffToTerminal on the next onRender cycle.
   */
  enqueueStaticCommit(lines: readonly string[]): void
}

/**
 * Provider wraps the user's React tree; consumers use useInkInstance()
 * to access the handle. Default null so a stray <Static> outside the
 * provider no-ops instead of throwing.
 */
export const InkInstanceContext = createContext<InkInstanceHandle | null>(null)

// eslint-disable-next-line custom-rules/no-top-level-side-effects
InkInstanceContext.displayName = 'InternalInkInstanceContext'

/**
 * Hook: get the handle. Returns null when rendered outside the Ink
 * provider (e.g. isolated component tests that don't wrap in provider).
 */
export function useInkInstance(): InkInstanceHandle | null {
  return useContext(InkInstanceContext)
}
