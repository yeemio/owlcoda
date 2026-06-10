/**
 * Minimal ScrollBox harness.
 *
 * Proves:
 * 1. Upstream Ink fork can render
 * 2. ScrollBox mounts with stickyScroll
 * 3. scrollBy / scrollToBottom work
 * 4. Viewport culling renders only visible children
 * 5. Keyboard scroll (PageUp/Down) works
 *
 * Run: npx tsx src/scrollbox-harness.tsx
 */

import React, { useEffect, useRef } from 'react'
import Box from './ink/components/Box.js'
import Text from './ink/components/Text.js'
import ScrollBox, { type ScrollBoxHandle } from './ink/components/ScrollBox.js'
import useInput from './ink/hooks/use-input.js'

// Generate 100 lines of content to test scrolling
const LINES = Array.from({ length: 100 }, (_, i) => `Line ${String(i + 1).padStart(3, '0')}  ${'─'.repeat(40)}  This is content that should be scrollable`)

function HarnessApp(): React.ReactNode {
  const scrollRef = useRef<ScrollBoxHandle>(null)
  const rows = process.stdout.rows ?? 24

  // After mount, scroll to bottom to verify stickyScroll
  useEffect(() => {
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToBottom()
    }, 500)
    return () => clearTimeout(timer)
  }, [])

  useInput((input, key) => {
    const handle = scrollRef.current
    if (!handle) return

    // PageUp: scroll up by half page
    if (key.pageUp) {
      handle.scrollBy(-Math.floor(rows / 2))
      return
    }
    // PageDown: scroll down by half page
    if (key.pageDown) {
      handle.scrollBy(Math.floor(rows / 2))
      return
    }
    // Home: scroll to top
    if (input === '\x1b[H' || input === '\x1bOH') {
      handle.scrollTo(0)
      return
    }
    // End: scroll to bottom
    if (input === '\x1b[F' || input === '\x1bOF') {
      handle.scrollToBottom()
      return
    }
    // q: quit
    if (input === 'q') {
      process.exit(0)
    }
    // Up/Down arrows: scroll by 1
    if (key.upArrow) {
      handle.scrollBy(-1)
      return
    }
    if (key.downArrow) {
      handle.scrollBy(1)
      return
    }
  })

  return (
    <Box flexDirection="column" height={rows}>
      <Box height={1} flexShrink={0}>
        <Text bold>ScrollBox Harness — PageUp/Down, Up/Down, Home/End, q=quit</Text>
      </Box>
      <ScrollBox
        ref={scrollRef}
        flexGrow={1}
        flexDirection="column"
        stickyScroll={true}
      >
        {LINES.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </ScrollBox>
      <Box height={1} flexShrink={0}>
        <Text dimColor>
          sticky={String(scrollRef.current?.isSticky() ?? '?')}
          {' '}scrollTop={String(scrollRef.current?.getScrollTop() ?? '?')}
          {' '}scrollH={String(scrollRef.current?.getScrollHeight() ?? '?')}
          {' '}viewH={String(scrollRef.current?.getViewportHeight() ?? '?')}
        </Text>
      </Box>
    </Box>
  )
}

// Use the upstream Ink fork's render function
async function main() {
  const { default: render } = await import('./ink/root.js')

  const instance = await render(<HarnessApp />, {
    exitOnCtrlC: true,
    patchConsole: false,
  })

  await instance.waitUntilExit()
  process.exit(0)
}

main().catch((err) => {
  console.error('Harness failed:', err)
  process.exit(1)
})
