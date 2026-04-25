// Minimal ThemedBox shim — pass-through to Box with no theme transformation.
// OwlCoda handles theming at its own layer.

import React, { type PropsWithChildren, type Ref } from 'react'
import Box from '../ink/components/Box.js'
import type { DOMElement } from '../ink/dom.js'

type ThemedBoxProps = PropsWithChildren<Record<string, any> & { ref?: Ref<DOMElement> }>

function ThemedBox({ children, ref, ...props }: ThemedBoxProps): React.ReactNode {
  return <Box ref={ref} {...props}>{children}</Box>
}

export default ThemedBox
export type { ThemedBoxProps }
export type { ThemedBoxProps as Props }
