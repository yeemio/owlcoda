// Minimal ThemedText shim — pass-through to Text with no theme transformation.

import React from 'react'
import Text from '../ink/components/Text.js'

type ThemedTextProps = Record<string, any> & { children?: React.ReactNode }

function ThemedText({ children, ...props }: ThemedTextProps): React.ReactNode {
  return <Text {...props}>{children}</Text>
}

export default ThemedText
export type { ThemedTextProps }
export type { ThemedTextProps as Props }
