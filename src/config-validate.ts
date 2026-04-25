/**
 * Config schema validation — validates OwlCoda config shape and types.
 * Returns list of human-readable errors for invalid fields.
 */

interface ValidationResult {
  valid: boolean
  errors: string[]
}

const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error']
const VALID_RESPONSE_STYLES = ['platform', 'backend', 'owlcoda']
const VALID_LOCAL_RUNTIME_PROTOCOLS = ['auto', 'openai_chat', 'anthropic_messages']

function checkNumber(obj: Record<string, unknown>, key: string, min?: number, max?: number): string | null {
  if (obj[key] === undefined) return null
  if (typeof obj[key] !== 'number') return `${key} must be a number, got ${typeof obj[key]}`
  const v = obj[key] as number
  if (min !== undefined && v < min) return `${key} must be ≥ ${min}, got ${v}`
  if (max !== undefined && v > max) return `${key} must be ≤ ${max}, got ${v}`
  return null
}

function checkString(obj: Record<string, unknown>, key: string, allowed?: string[]): string | null {
  if (obj[key] === undefined) return null
  if (typeof obj[key] !== 'string') return `${key} must be a string, got ${typeof obj[key]}`
  if (allowed && !allowed.includes(obj[key] as string)) {
    return `${key} must be one of [${allowed.join(', ')}], got "${obj[key]}"`
  }
  return null
}

function checkBoolean(obj: Record<string, unknown>, key: string): string | null {
  if (obj[key] === undefined) return null
  if (typeof obj[key] !== 'boolean') return `${key} must be a boolean, got ${typeof obj[key]}`
  return null
}

export function validateConfig(raw: unknown): ValidationResult {
  const errors: string[] = []

  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['Config must be a JSON object'] }
  }

  const obj = raw as Record<string, unknown>

  // Top-level fields
  const checks = [
    checkNumber(obj, 'port', 1, 65535),
    checkString(obj, 'host'),
    checkString(obj, 'routerUrl'),
    checkString(obj, 'localRuntimeProtocol', VALID_LOCAL_RUNTIME_PROTOCOLS),
    checkNumber(obj, 'routerTimeoutMs', 1000),
    checkString(obj, 'logLevel', VALID_LOG_LEVELS),
    checkString(obj, 'logFilePath'),
    checkNumber(obj, 'logFileMaxBytes', 1024),
    checkNumber(obj, 'logFileKeep', 1, 100),
    checkString(obj, 'adminToken'),
    checkString(obj, 'responseModelStyle', VALID_RESPONSE_STYLES),
    checkString(obj, 'defaultModel'),
    checkBoolean(obj, 'reverseMapInResponse'),
  ]

  for (const err of checks) {
    if (err) errors.push(err)
  }

  // models array
  if (obj.models !== undefined) {
    if (!Array.isArray(obj.models)) {
      errors.push('models must be an array')
    } else {
      for (let i = 0; i < obj.models.length; i++) {
        const m = obj.models[i]
        if (!m || typeof m !== 'object') {
          errors.push(`models[${i}] must be an object`)
        } else {
          const model = m as Record<string, unknown>
          if (typeof model.id !== 'string' || !model.id) {
            errors.push(`models[${i}].id must be a non-empty string`)
          }
          if (typeof model.backendModel !== 'string' || !model.backendModel) {
            errors.push(`models[${i}].backendModel must be a non-empty string`)
          }
        }
      }
    }
  }

  // middleware sub-object
  if (obj.middleware !== undefined) {
    if (typeof obj.middleware !== 'object' || obj.middleware === null) {
      errors.push('middleware must be an object')
    } else {
      const mw = obj.middleware as Record<string, unknown>
      const mwChecks = [
        checkNumber(mw, 'rateLimitRpm', 1),
        checkNumber(mw, 'retryMaxAttempts', 0, 10),
        checkNumber(mw, 'retryBaseDelayMs', 100),
        checkBoolean(mw, 'fallbackEnabled'),
        checkNumber(mw, 'circuitBreakerThreshold', 1, 100),
        checkNumber(mw, 'circuitBreakerCooldownMs', 1000),
        checkNumber(mw, 'sloTargetPercent', 0, 100),
        checkNumber(mw, 'requestTimeoutMs', 1000),
        checkNumber(mw, 'maxRequestBodyBytes', 1024),
      ]
      for (const err of mwChecks) {
        if (err) errors.push(`middleware.${err}`)
      }
    }
  }

  // modelMap (legacy)
  if (obj.modelMap !== undefined && (typeof obj.modelMap !== 'object' || obj.modelMap === null || Array.isArray(obj.modelMap))) {
    errors.push('modelMap must be an object (legacy field)')
  }

  return { valid: errors.length === 0, errors }
}
