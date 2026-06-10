/**
 * Tool schema-error helper (0.13.59).
 *
 * Background. Pre-0.13.59 a `write({})` call returned `Error: Path must
 * be a non-empty string` and an `edit({path: '...'})` returned `Error:
 * oldStr must not be empty`. Both were correct refusals but neither
 * told the model what shape it was supposed to send. Long-context
 * sessions (kimi-code at ~700K tokens, deepseek at 800K) reproducibly
 * stream tool_use blocks with an empty input or missing fields; the
 * model then retries the SAME malformed shape because the error
 * message gives it nothing to fix.
 *
 * 0.13.59 changes the error path: when a required field is empty or
 * missing, return a structured message that names the schema, echoes
 * the actual input received, and explicitly tells the model not to
 * retry the same shape. Single-turn self-recovery for the failure
 * mode that previously took 3 turns and a soft loop intercept.
 *
 * The helper lives in its own module so all tools (write, edit,
 * future ones) share a consistent error shape without each tool
 * reinventing the format.
 */

import type { ToolResult } from './types.js'

/**
 * Build the structured schema-error tool_result. Truncates the
 * received-input echo at 200 chars to avoid noisy huge dumps.
 *
 * Returned metadata shape (open record so it slots into the existing
 * ToolResult.metadata):
 *   - schemaError: true
 *   - toolName: string
 *   - missingFields: string[]
 */
export function buildSchemaError(
  toolName: string,
  missingFields: string[],
  receivedInput: unknown,
  schemaSummary: string,
): ToolResult {
  const inputPreview = previewInput(receivedInput)
  const missingList = missingFields.map((f) => `\`${f}\``).join(', ')
  return {
    output: [
      `Error: ${toolName} tool called with empty or missing required field(s): ${missingList}.`,
      `Schema: { ${schemaSummary} }`,
      `Received input: ${inputPreview}`,
      'Re-emit the call with all required fields populated. ' +
      'Do NOT retry the same input shape — fix the missing field(s), ' +
      'or stop and ask the user if you cannot determine the value.',
    ].join('\n'),
    isError: true,
    metadata: {
      schemaError: true,
      toolName,
      missingFields,
    },
  }
}

function previewInput(input: unknown): string {
  let s: string
  try {
    s = JSON.stringify(input ?? null)
  } catch {
    s = String(input)
  }
  if (s.length > 200) return s.slice(0, 197) + '...'
  return s
}

/**
 * Check write input shape and return list of missing/empty required
 * fields. Empty string counts as missing (a zero-length path is never
 * valid; a zero-length content is technically valid for "create empty
 * file" — handled separately in the caller if needed).
 */
export function checkWriteRequiredFields(input: unknown): string[] {
  const missing: string[] = []
  if (!input || typeof input !== 'object') {
    return ['path', 'content']
  }
  const obj = input as Record<string, unknown>
  if (typeof obj['path'] !== 'string' || obj['path'].length === 0) missing.push('path')
  // content === '' is allowed (intentional empty-file write); only
  // flag missing or non-string. Long-context dropped-field bug
  // typically loses the field entirely, not blanks it.
  if (!('content' in obj) || typeof obj['content'] !== 'string') missing.push('content')
  return missing
}

/**
 * Check edit input shape. oldStr must be present and non-empty (the
 * tool already refuses empty oldStr); newStr must be present (empty
 * is allowed — it's a deletion).
 */
export function checkEditRequiredFields(input: unknown): string[] {
  const missing: string[] = []
  if (!input || typeof input !== 'object') {
    return ['path', 'oldStr', 'newStr']
  }
  const obj = input as Record<string, unknown>
  if (typeof obj['path'] !== 'string' || obj['path'].length === 0) missing.push('path')
  if (typeof obj['oldStr'] !== 'string' || obj['oldStr'].length === 0) missing.push('oldStr')
  if (!('newStr' in obj) || typeof obj['newStr'] !== 'string') missing.push('newStr')
  return missing
}

/**
 * 0.13.62 (B): pre-flight schema check used by `executeTools` to
 * short-circuit repeated empty-input retries before the tool even
 * runs. Returns the same `missingFields[]` shape the tool would
 * itself produce, so the caller can build a stable dedup key
 * `${toolName}:${missingFields.sort().join(',')}` and count
 * consecutive failures.
 *
 * Why dispatcher-level (not loop-guard level)? The 0.13.55 soft loop
 * intercept is keyed on `intentKey = ${category}:${intentTarget}`,
 * which degenerates to `bash:` / `write:` when the tool input is
 * empty — so two `write({})` calls don't dedupe and the second-hit
 * hard-terminate path never fires. The mionyee dogfood (2026-05-07)
 * showed kimi-code emitting `write({})` 8+ times in a row past the
 * soft intercept. This pre-check fixes that by keying on
 * (toolName, missingFields), which is stable regardless of empty
 * input.
 *
 * Returns null when the tool isn't one we have a checker for, or
 * when the input is well-formed.
 */
export function predictSchemaFailure(
  toolName: string,
  input: unknown,
): { missingFields: string[] } | null {
  let missing: string[] = []
  if (toolName === 'write') {
    missing = checkWriteRequiredFields(input)
  } else if (toolName === 'edit') {
    missing = checkEditRequiredFields(input)
  } else {
    return null
  }
  if (missing.length === 0) return null
  return { missingFields: missing }
}
