import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '../src/i18n'
import { Advanced } from '../src/components/Advanced'

describe('Advanced', () => {
  it('is collapsed by default — section present but hidden', () => {
    render(
      <I18nProvider>
        <Advanced testId="adv">
          <span>inner content</span>
        </Advanced>
      </I18nProvider>,
    )
    expect(screen.getByTestId('adv-section')).toBeInTheDocument()
    expect((screen.getByTestId('adv-section') as HTMLElement).style.display).toBe('none')
  })

  it('clicking the toggle expands the section (display becomes flex)', () => {
    render(
      <I18nProvider>
        <Advanced testId="adv">
          <span>inner content</span>
        </Advanced>
      </I18nProvider>,
    )
    fireEvent.click(screen.getByTestId('adv-toggle'))
    expect((screen.getByTestId('adv-section') as HTMLElement).style.display).toBe('flex')
  })

  it('aria-expanded tracks open/closed state', () => {
    render(
      <I18nProvider>
        <Advanced testId="adv">
          <span>inner</span>
        </Advanced>
      </I18nProvider>,
    )
    expect(screen.getByTestId('adv-toggle')).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByTestId('adv-toggle'))
    expect(screen.getByTestId('adv-toggle')).toHaveAttribute('aria-expanded', 'true')
  })
})
