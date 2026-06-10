import { verifyHtmlDeck, type HtmlDeckRequiredMarker } from '../verification-packs/html-deck.js'
import type { NativeToolDef, ToolResult } from './types.js'

export interface ArtifactVerifyInput {
  packId: 'html_deck' | string
  deckPath: string
  expectedSections: number
  buildNotesPath?: string
  requiredMarkers?: Array<string | HtmlDeckRequiredMarker>
  minFileSizeBytes?: number
  minSectionBytes?: number
  forbiddenTerms?: string[]
}

export function createArtifactVerifyTool(): NativeToolDef<ArtifactVerifyInput> {
  return {
    name: 'ArtifactVerify',
    description:
      'Run deterministic OwlCoda artifact verification packs. Currently supports ' +
      'packId=html_deck for HTML deck section count, title placeholder, build notes, ' +
      'required markers, min file size, and forbidden term checks.',
    maturity: 'beta',

    async execute(input: ArtifactVerifyInput): Promise<ToolResult> {
      const validation = validateInput(input)
      if (validation) return validation

      const result = verifyHtmlDeck({
        deckPath: input.deckPath,
        expectedSections: input.expectedSections,
        ...(typeof input.buildNotesPath === 'string' && input.buildNotesPath.trim()
          ? { buildNotesPath: input.buildNotesPath }
          : {}),
        ...(Array.isArray(input.requiredMarkers) ? { requiredMarkers: input.requiredMarkers } : {}),
        ...(typeof input.minFileSizeBytes === 'number' ? { minFileSizeBytes: input.minFileSizeBytes } : {}),
        ...(typeof input.minSectionBytes === 'number' ? { minSectionBytes: input.minSectionBytes } : {}),
        ...(Array.isArray(input.forbiddenTerms) ? { forbiddenTerms: input.forbiddenTerms } : {}),
      })

      return {
        output: JSON.stringify(result, null, 2),
        isError: false,
        metadata: { result },
      }
    },
  }
}

function validateInput(input: ArtifactVerifyInput): ToolResult | null {
  if (!input || input.packId !== 'html_deck') {
    return error('Error: packId must be "html_deck".', 'artifact-verify:invalid-pack')
  }
  if (typeof input.deckPath !== 'string' || input.deckPath.trim() === '') {
    return error('Error: deckPath is required.', 'artifact-verify:missing-deckPath')
  }
  if (typeof input.expectedSections !== 'number' || !Number.isInteger(input.expectedSections) || input.expectedSections < 0) {
    return error('Error: expectedSections must be a non-negative integer.', 'artifact-verify:invalid-expectedSections')
  }
  if (input.buildNotesPath !== undefined && typeof input.buildNotesPath !== 'string') {
    return error('Error: buildNotesPath must be a string when provided.', 'artifact-verify:invalid-buildNotesPath')
  }
  if (input.minFileSizeBytes !== undefined && (
    typeof input.minFileSizeBytes !== 'number'
    || !Number.isFinite(input.minFileSizeBytes)
    || input.minFileSizeBytes < 0
  )) {
    return error('Error: minFileSizeBytes must be a non-negative number when provided.', 'artifact-verify:invalid-minFileSizeBytes')
  }
  if (input.forbiddenTerms !== undefined && !isStringArray(input.forbiddenTerms)) {
    return error('Error: forbiddenTerms must be an array of strings when provided.', 'artifact-verify:invalid-forbiddenTerms')
  }
  if (input.requiredMarkers !== undefined && !isRequiredMarkers(input.requiredMarkers)) {
    return error(
      'Error: requiredMarkers must be strings or { marker, label } objects when provided.',
      'artifact-verify:invalid-requiredMarkers',
    )
  }
  return null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isRequiredMarkers(value: unknown): value is Array<string | HtmlDeckRequiredMarker> {
  return Array.isArray(value)
    && value.every(item => (
      typeof item === 'string'
      || (
        typeof item === 'object'
        && item !== null
        && !Array.isArray(item)
        && typeof (item as { marker?: unknown }).marker === 'string'
        && (
          (item as { label?: unknown }).label === undefined
          || typeof (item as { label?: unknown }).label === 'string'
        )
      )
    ))
}

function error(output: string, failureCategory: string): ToolResult {
  return {
    output,
    isError: true,
    metadata: { failureCategory },
  }
}
