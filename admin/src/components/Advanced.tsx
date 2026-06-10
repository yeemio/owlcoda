import { useState, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import type { TranslationKey } from '../i18n'

export function Advanced({
  children,
  testId = 'advanced',
  labelKey,
}: {
  children: ReactNode
  testId?: string
  labelKey?: TranslationKey
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const showLabel = labelKey ? `+ ${t(labelKey)}` : t('showAdvanced')
  const hideLabel = labelKey ? `- ${t(labelKey)}` : t('hideAdvanced')
  return (
    <>
      <button
        type="button"
        className="add-model-advanced-toggle"
        onClick={() => setOpen(v => !v)}
        data-testid={`${testId}-toggle`}
        aria-expanded={open}
      >
        {open ? hideLabel : showLabel}
      </button>
      <div className="add-model-advanced" data-testid={`${testId}-section`} style={{ display: open ? 'flex' : 'none' }}>
        {children}
      </div>
    </>
  )
}
