import type { ReactNode } from 'react'

interface Props {
  /** Small uppercase label above the title. */
  eyebrow?: string
  title: string
  /** Subtitle / description block under the title. */
  sub?: ReactNode
  /** Right-side slot for status pills or action buttons. */
  right?: ReactNode
  testId?: string
}

export function PageHeader({ eyebrow, title, sub, right, testId }: Props) {
  return (
    <header className="page-header" data-testid={testId}>
      {eyebrow && <div className="page-eyebrow">{eyebrow}</div>}
      <div className="page-header-title-row">
        <h2>{title}</h2>
        <span className="spacer" />
        {right}
      </div>
      {sub && <div className="page-header-sub">{sub}</div>}
    </header>
  )
}
