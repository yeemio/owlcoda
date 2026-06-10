import React from "react"
import { Text } from "../../ink.js"

export function HighlightedInput({ children }: { children?: React.ReactNode }): React.ReactNode {
  return <Text>{children}</Text>
}
