/**
 * Error ring buffer for proxy diagnostics.
 * Stores the last N errors for /doctor to report.
 */

export interface DiagnosticError {
  timestamp: string
  endpoint: string
  errorType: string
  message: string
  suggestion?: string
}

const MAX_ERRORS = 20
const errors: DiagnosticError[] = []
const startTime = Date.now()

export function recordError(endpoint: string, errorType: string, message: string, suggestion?: string): void {
  errors.push({
    timestamp: new Date().toISOString(),
    endpoint,
    errorType,
    message,
    suggestion,
  })
  if (errors.length > MAX_ERRORS) {
    errors.shift()
  }
}

export function getRecentErrors(count = 5): DiagnosticError[] {
  return errors.slice(-count)
}

export function getErrorCount(): number {
  return errors.length
}

export function getUptime(): number {
  return Math.round((Date.now() - startTime) / 1000)
}

export function clearErrors(): void {
  errors.length = 0
}

export function suggestModelFix(requestedModel: string, availableModels: string[]): string | undefined {
  if (availableModels.length === 0) return undefined

  // Try partial match
  const lower = requestedModel.toLowerCase()
  const partial = availableModels.find(m => m.toLowerCase().includes(lower) || lower.includes(m.toLowerCase()))
  if (partial) return `Did you mean "${partial}"?`

  // Suggest first available
  return `Available models: ${availableModels.slice(0, 3).join(', ')}${availableModels.length > 3 ? '...' : ''}`
}
