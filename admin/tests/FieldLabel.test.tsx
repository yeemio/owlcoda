import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nProvider } from '../src/i18n'
import { FieldLabel } from '../src/components/FieldLabel'

describe('FieldLabel', () => {
  it('renders localized name with the raw config key as subscript', () => {
    render(<I18nProvider><FieldLabel field="backendModel" /></I18nProvider>)
    expect(screen.getByText('Backend model')).toBeInTheDocument()
    expect(screen.getByText('backendModel')).toBeInTheDocument()
  })
  it('omits the code subscript for fields that have none (apiKey)', () => {
    render(<I18nProvider><FieldLabel field="apiKey" /></I18nProvider>)
    expect(screen.getByText('API Key')).toBeInTheDocument()
    expect(screen.queryByText('apiKey')).toBeNull()
  })
})
