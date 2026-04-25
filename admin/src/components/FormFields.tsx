/**
 * Thin field primitives shared by EditFieldsForm / AddModelDialog / KeyForm.
 * Not a "design system" — just consistent labels + inline hints.
 */

import type { ChangeEvent } from 'react'

interface TextFieldProps {
  label: string
  value: string
  onChange: (next: string) => void
  placeholder?: string
  testId?: string
  disabled?: boolean
  autoFocus?: boolean
  type?: 'text' | 'password' | 'number'
}

export function TextField(props: TextFieldProps) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <input
        className="field-input"
        type={props.type ?? 'text'}
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        autoFocus={props.autoFocus}
        data-testid={props.testId}
        onChange={(e: ChangeEvent<HTMLInputElement>) => props.onChange(e.target.value)}
      />
    </label>
  )
}

interface CsvFieldProps {
  label: string
  values: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  testId?: string
}

export function CsvField(props: CsvFieldProps) {
  return (
    <TextField
      label={props.label}
      placeholder={props.placeholder ?? 'comma-separated'}
      testId={props.testId}
      value={props.values.join(', ')}
      onChange={(next) => props.onChange(
        next.split(',').map(s => s.trim()).filter(s => s.length > 0),
      )}
    />
  )
}

interface NumberFieldProps {
  label: string
  value: number | undefined
  onChange: (next: number | undefined) => void
  placeholder?: string
  testId?: string
}

export function NumberField(props: NumberFieldProps) {
  return (
    <TextField
      label={props.label}
      type="number"
      placeholder={props.placeholder}
      testId={props.testId}
      value={props.value === undefined ? '' : String(props.value)}
      onChange={(next) => {
        const trimmed = next.trim()
        if (trimmed === '') { props.onChange(undefined); return }
        const n = Number(trimmed)
        props.onChange(Number.isFinite(n) ? n : undefined)
      }}
    />
  )
}
