import type { ReactNode } from 'react'

export type PillKind = 'ok' | 'warn' | 'err' | 'info' | 'muted' | 'planned' | 'solid'

interface Props {
  kind?: PillKind
  testId?: string
  children: ReactNode
}

/**
 * Small uppercase status chip used in page headers, list rows, and run cards.
 * Variants map to existing tone tokens in styles.css; kind maps 1:1 to a CSS
 * class so the chip respects light/dark theming via tokens, not hardcoded hex.
 */
export function Pill({ kind = 'muted', testId, children }: Props) {
  return (
    <span className={`pill ${kind}`} data-testid={testId}>
      {children}
    </span>
  )
}
