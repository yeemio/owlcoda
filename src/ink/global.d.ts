// JSX intrinsic element declarations for the custom Ink fork.
import type { DOMElement } from './dom.js'

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': Record<string, unknown>
      'ink-text': Record<string, unknown>
      'ink-link': Record<string, unknown>
      'ink-raw-ansi': Record<string, unknown>
    }
  }
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': Record<string, unknown>
      'ink-text': Record<string, unknown>
      'ink-link': Record<string, unknown>
      'ink-raw-ansi': Record<string, unknown>
    }
  }
}
