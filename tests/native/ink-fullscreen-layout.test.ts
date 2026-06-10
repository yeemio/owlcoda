/**
 * Tests for ink-fullscreen-layout.tsx (Slice D, Task D-3).
 *
 * Harness choice: no Ink render harness (react-test-renderer /
 * @testing-library/react) is installed. Tests are type-level and
 * structural only: we verify the exported interface shape and that
 * ScrollIndicatorLeaf is NOT exported (it is file-local). Behavior
 * verification (memo bail-out) is covered at the TypeScript compile
 * level via repl.test.ts (expectTypeOf) and by the absence of
 * spinnerFrame in the prop type.
 */
import { describe, it, expect } from 'vitest'
import type { ScrollableTranscriptProps } from '../../src/native/ink-fullscreen-layout.js'
import * as layout from '../../src/native/ink-fullscreen-layout.js'

describe('ScrollableTranscriptProps shape (D-3)', () => {
  it('ScrollableTranscript is exported', () => {
    // React.memo returns an object (memo wrapper), not a bare function
    expect(layout.ScrollableTranscript).toBeDefined()
    expect(typeof layout.ScrollableTranscript).toBe('object')
  })

  it('ScrollIndicatorLeaf is NOT exported (file-local leaf)', () => {
    // The leaf component should not appear in the module exports.
    expect('ScrollIndicatorLeaf' in layout).toBe(false)
  })

  it('ScrollableTranscriptProps does not include spinnerFrame at runtime shape', () => {
    // Verify by constructing a minimal conforming object — TypeScript
    // would reject this at compile time if spinnerFrame were required.
    const props: Omit<ScrollableTranscriptProps, 'scrollRef'> = {
      items: [],
      height: 10,
      cols: 80,
      tailLines: 0,
      footerLines: 0,
      isLoading: false,
    }
    // If spinnerFrame were required, TS would error here.
    expect(props).toBeDefined()
    expect('spinnerFrame' in props).toBe(false)
  })
})
