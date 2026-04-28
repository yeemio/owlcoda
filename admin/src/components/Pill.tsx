import type { ReactNode } from 'react'

export type PillKind = 'ok' | 'warn' | 'err' | 'info' | 'muted' | 'planned' | 'solid'

interface Props {
  kind?: PillKind
  testId?: string
  children: ReactNode
}

export function Pill({ kind = 'muted', testId, children }: Props) {
  return (
    <span className={`pill ${kind}`} data-testid={testId}>
      {children}
    </span>
  )
}
