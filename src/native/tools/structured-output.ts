/**
 * OwlCoda Native StructuredOutput Tool (SyntheticOutputTool)
 *
 * Returns structured JSON output for non-interactive sessions.
 * Validates input against a provided JSON schema.
 *
 * Upstream parity notes:
 * - Upstream uses Ajv validation, only enabled in non-interactive mode
 * - Our version: validates a focused JSON Schema subset, returns formatted JSON
 */

import type { NativeToolDef, ToolResult } from './types.js'

export interface StructuredOutputInput {
  schema?: JsonSchema
  data?: unknown
  [key: string]: unknown
}

type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'

interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[]
  required?: string[]
  properties?: Record<string, JsonSchema>
  additionalProperties?: boolean | JsonSchema
  items?: JsonSchema
  enum?: unknown[]
  const?: unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stableJson(value: unknown): string {
  return JSON.stringify(value)
}

function typeName(value: unknown): JsonSchemaType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'boolean') return 'boolean'
  return 'object'
}

function typeMatches(value: unknown, expected: JsonSchemaType): boolean {
  switch (expected) {
    case 'object':
      return isPlainObject(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
  }
}

function validateAgainstSchema(value: unknown, schema: JsonSchema, path = '$'): string[] {
  const errors: string[] = []

  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => stableJson(candidate) === stableJson(value))) {
    errors.push(`${path} must be one of ${schema.enum.map(stableJson).join(', ')}`)
  }

  if ('const' in schema && stableJson(schema.const) !== stableJson(value)) {
    errors.push(`${path} must equal ${stableJson(schema.const)}`)
  }

  const expectedTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  if (expectedTypes.length > 0 && !expectedTypes.some(expected => typeMatches(value, expected))) {
    const expected = expectedTypes.join(' or ')
    const actual = typeName(value)
    errors.push(`${path} must be ${expected}${actual === 'integer' && expectedTypes.includes('number') ? '' : ` (got ${actual})`}`)
    return errors
  }

  if (isPlainObject(value)) {
    const properties = schema.properties ?? {}
    for (const requiredField of schema.required ?? []) {
      if (!(requiredField in value)) {
        errors.push(`${path}.${requiredField} is required`)
      }
    }

    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in value) {
        errors.push(...validateAgainstSchema(value[key], childSchema, `${path}.${key}`))
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          errors.push(`${path}.${key} is not allowed`)
        }
      }
    } else if (isPlainObject(schema.additionalProperties)) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          errors.push(...validateAgainstSchema(value[key], schema.additionalProperties, `${path}.${key}`))
        }
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      errors.push(...validateAgainstSchema(item, schema.items as JsonSchema, `${path}[${index}]`))
    })
  }

  return errors
}

export function createStructuredOutputTool(): NativeToolDef<StructuredOutputInput> {
  return {
    name: 'StructuredOutput',
    description:
      'Return structured output as formatted JSON. ' +
      'Call this tool exactly once at the end of a response to provide structured JSON output. ' +
      'When a JSON schema is provided, validates the data payload against the supported schema subset ' +
      '(type, required, properties, items, enum, const, additionalProperties=false).',
    maturity: 'beta' as const,

    async execute(input: StructuredOutputInput): Promise<ToolResult> {
      if (!input || typeof input !== 'object') {
        return { output: 'Error: input must be an object.', isError: true }
      }

      const hasSchema = Object.prototype.hasOwnProperty.call(input, 'schema')
      const hasData = Object.prototype.hasOwnProperty.call(input, 'data')
      if (hasSchema && !hasData) {
        return { output: 'Error: data is required when schema is provided.', isError: true }
      }

      const payload = hasData ? input.data : input
      if (hasSchema) {
        if (!isPlainObject(input.schema)) {
          return { output: 'Error: schema must be an object.', isError: true }
        }

        const errors = validateAgainstSchema(payload, input.schema)
        if (errors.length > 0) {
          return {
            output: `Error: structured output does not match schema:\n- ${errors.join('\n- ')}`,
            isError: true,
            metadata: { structuredOutput: payload, schemaValidated: false, validationErrors: errors },
          }
        }
      }

      const json = JSON.stringify(payload, null, 2)

      return {
        output: json,
        isError: false,
        metadata: { structuredOutput: payload, schemaValidated: hasSchema },
      }
    },
  }
}
