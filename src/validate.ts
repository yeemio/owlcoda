/**
 * Config validation command — comprehensive config checks.
 * Combines structural (schema) and semantic (logic) validation.
 */

import { existsSync, readFileSync } from 'node:fs'
import { validateSemantics } from './config-semantic.js'

export interface ValidationIssue {
  level: 'error' | 'warn' | 'info'
  code: string
  message: string
}

export interface ValidationResult {
  configPath: string
  exists: boolean
  parseable: boolean
  issues: ValidationIssue[]
  raw?: Record<string, unknown>
}

/**
 * Run full config validation: file existence, JSON parse, schema, semantic.
 */
export function runValidation(configPath?: string): ValidationResult {
  const path = configPath || resolveDefaultConfigPath()
  const result: ValidationResult = {
    configPath: path,
    exists: false,
    parseable: false,
    issues: [],
  }

  // 1. File existence
  if (!existsSync(path)) {
    result.issues.push({
      level: 'error',
      code: 'FILE_NOT_FOUND',
      message: `Config file not found: ${path}`,
    })
    return result
  }
  result.exists = true

  // 2. JSON parse
  let raw: unknown
  try {
    const content = readFileSync(path, 'utf-8')
    raw = JSON.parse(content)
  } catch (e) {
    result.issues.push({
      level: 'error',
      code: 'INVALID_JSON',
      message: `Failed to parse JSON: ${e instanceof Error ? e.message : String(e)}`,
    })
    return result
  }
  result.parseable = true

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    result.issues.push({
      level: 'error',
      code: 'NOT_OBJECT',
      message: 'Config must be a JSON object',
    })
    return result
  }
  result.raw = raw as Record<string, unknown>

  // 3. Schema checks (required fields)
  const obj = raw as Record<string, unknown>
  if (!obj['routerUrl'] || typeof obj['routerUrl'] !== 'string') {
    result.issues.push({ level: 'error', code: 'MISSING_ROUTER_URL', message: 'routerUrl is required and must be a string' })
  }
  if (!obj['port'] || typeof obj['port'] !== 'number') {
    result.issues.push({ level: 'warn', code: 'MISSING_PORT', message: 'port not set — will use default 8019' })
  }
  if (!Array.isArray(obj['models']) || (obj['models'] as unknown[]).length === 0) {
    result.issues.push({ level: 'error', code: 'NO_MODELS', message: 'models array is required and must not be empty' })
  }

  // 4. Semantic checks
  const semanticWarnings = validateSemantics(obj)
  for (const sw of semanticWarnings) {
    result.issues.push({
      level: sw.level,
      code: sw.code,
      message: sw.message,
    })
  }

  return result
}

function resolveDefaultConfigPath(): string {
  const home = process.env['OWLCODA_HOME'] || `${process.env['HOME']}/.owlcoda`
  return `${home}/config.json`
}

/**
 * Format validation result for CLI output.
 */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = []
  lines.push(`Config: ${result.configPath}`)
  lines.push('')

  if (!result.exists) {
    lines.push('❌ Config file not found')
    lines.push('   Run `owlcoda init` to create one.')
    return lines.join('\n')
  }

  if (!result.parseable) {
    lines.push('❌ Config file is not valid JSON')
    return lines.join('\n')
  }

  const errors = result.issues.filter(i => i.level === 'error')
  const warnings = result.issues.filter(i => i.level === 'warn')
  const infos = result.issues.filter(i => i.level === 'info')

  if (errors.length === 0 && warnings.length === 0) {
    lines.push('✅ Config is valid — no issues found.')
    return lines.join('\n')
  }

  if (errors.length > 0) {
    lines.push(`Errors (${errors.length}):`)
    for (const e of errors) {
      lines.push(`  ❌ [${e.code}] ${e.message}`)
    }
    lines.push('')
  }

  if (warnings.length > 0) {
    lines.push(`Warnings (${warnings.length}):`)
    for (const w of warnings) {
      lines.push(`  ⚠️  [${w.code}] ${w.message}`)
    }
    lines.push('')
  }

  if (infos.length > 0) {
    for (const i of infos) {
      lines.push(`  ℹ️  [${i.code}] ${i.message}`)
    }
  }

  const summary = errors.length > 0
    ? `❌ ${errors.length} error(s), ${warnings.length} warning(s)`
    : `⚠️  ${warnings.length} warning(s)`
  lines.push(summary)

  return lines.join('\n')
}
