import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createArtifactVerifyTool } from '../../../src/native/tools/artifact-verify.js'
import { NATIVE_TOOL_SCHEMAS } from '../../../src/native/tool-defs.js'

describe('ArtifactVerify native tool', () => {
  let tempDir = ''

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'owlcoda-native-artifact-verify-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('exposes the html_deck input schema', () => {
    expect(NATIVE_TOOL_SCHEMAS['ArtifactVerify']).toMatchObject({
      type: 'object',
      required: ['packId', 'deckPath', 'expectedSections'],
    })
  })

  it('runs html_deck verification and returns JSON', async () => {
    const deckPath = await writeDeck({
      title: 'Runtime Roadmap',
      sections: 2,
      bodyExtra: '<p>P1 marker</p><p>P2 marker</p>',
      buildNotes: '# Build Notes\n',
    })

    const result = await createArtifactVerifyTool().execute({
      packId: 'html_deck',
      deckPath,
      expectedSections: 2,
      requiredMarkers: ['P1 marker', { marker: 'P2 marker', label: 'second marker' }],
      minFileSizeBytes: 20,
      forbiddenTerms: ['INTERNAL_ONLY'],
    })

    expect(result.isError).toBe(false)
    const payload = JSON.parse(result.output) as Record<string, unknown>
    expect(payload).toMatchObject({
      packId: 'html_deck',
      status: 'passed',
      passed: true,
      artifactPath: deckPath,
    })
  })

  it('surfaces failed html_deck checks as structured JSON, not a thrown tool error', async () => {
    const deckPath = await writeDeck({
      title: 'Deck [必填]',
      sections: 3,
      bodyExtra: '<p>INTERNAL_ONLY</p>',
      buildNotes: null,
    })

    const result = await createArtifactVerifyTool().execute({
      packId: 'html_deck',
      deckPath,
      expectedSections: 2,
      requiredMarkers: ['P18_SPECIAL'],
      forbiddenTerms: ['INTERNAL_ONLY'],
    })

    expect(result.isError).toBe(false)
    const payload = JSON.parse(result.output) as { status: string; passed: boolean; checks: Array<{ checkId: string; passed: boolean }> }
    expect(payload.status).toBe('failed')
    expect(payload.passed).toBe(false)
    expect(payload.checks.filter(check => !check.passed).map(check => check.checkId)).toEqual([
      'section_count',
      'title_placeholder',
      'build_notes_exists',
      'required_markers',
      'forbidden_terms',
    ])
  })

  it('rejects unsupported packs', async () => {
    const result = await createArtifactVerifyTool().execute({
      packId: 'markdown_report',
      deckPath: join(tempDir, 'deck.html'),
      expectedSections: 1,
    })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('packId')
  })

  async function writeDeck(options: {
    title: string
    sections: number
    bodyExtra?: string
    buildNotes?: string | null
  }): Promise<string> {
    const deckPath = join(tempDir, 'deck.html')
    const sections = Array.from(
      { length: options.sections },
      (_, index) => `<section><h1>Slide ${index + 1}</h1><p>Detailed content for section ${index + 1}: in-depth analysis, data points, case studies, and supporting evidence for the topic covered on this page. Additional context is provided to ensure the audience understands the full scope of the subject matter.</p></section>`,
    ).join('\n')
    await writeFile(
      deckPath,
      [
        '<!doctype html>',
        '<html>',
        '<head>',
        `<title>${options.title}</title>`,
        '</head>',
        '<body>',
        options.bodyExtra ?? '',
        sections,
        '</body>',
        '</html>',
      ].join('\n'),
      'utf8',
    )
    if (options.buildNotes !== null) {
      await writeFile(join(tempDir, 'build-notes.md'), options.buildNotes ?? '# Build Notes\n', 'utf8')
    }
    return deckPath
  }
})
