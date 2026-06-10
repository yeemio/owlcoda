import { useLayoutEffect, useRef } from 'react'
import { useInkInstance } from './InkInstanceContext.js'

/**
 * <Static items={readonly string[]}> — append-only transcript items
 * that commit to terminal scrollback.
 *
 * On mount, enqueues all current items. On re-render, enqueues only
 * the newly-appended delta (items beyond the committed index). The
 * items array is treated as append-only; shortening or reordering
 * is NOT supported — only the growing tail is observed.
 *
 * Renders nothing to the dynamic viewport. The actual stdout write
 * happens in writeDiffToTerminal on the next frame, via the Ink
 * instance's enqueueStaticCommit → pendingStaticCommit → onRender
 * drain → frame.staticCommit → log.render emission path.
 *
 * INVARIANT: This component NEVER calls terminal.stdout.write
 * directly. enqueueStaticCommit is queue-only by contract.
 */
export function Static({ items }: { items: readonly string[] }): null {
  const instance = useInkInstance()
  const committedCountRef = useRef(0)

  useLayoutEffect(() => {
    if (!instance) return
    // Reset signal: items.length === 0 means the consumer explicitly
    // cleared the append-only buffer (e.g. user ran /clear). Reset the
    // commit counter to 0 so subsequent growth commits cleanly from
    // the start rather than skipping past the pre-clear high-water
    // mark. Without this, /clear followed by new transcript items
    // would leave a "phantom window" of items that silently bypass
    // scrollback commit until the count exceeds the old watermark.
    if (items.length === 0) {
      committedCountRef.current = 0
      return
    }
    if (items.length <= committedCountRef.current) return
    const delta = items.slice(committedCountRef.current)
    committedCountRef.current = items.length
    instance.enqueueStaticCommit(delta)
  }, [instance, items])

  return null
}
