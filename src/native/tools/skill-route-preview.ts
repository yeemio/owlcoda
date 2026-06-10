import type { NativeToolDef, ToolExecutionContext, ToolResult } from './types.js'
import { previewSkillRoute } from '../../skills/router-preview.js'
import { writeSkillRoute } from '../run-workspace.js'

export interface SkillRoutePreviewInput {
  prompt: string
}

export function createSkillRoutePreviewTool(): NativeToolDef<SkillRoutePreviewInput> {
  return {
    name: 'SkillRoutePreview',
    description:
      'Preview OwlCoda workflow skill routing for a user prompt. ' +
      'Read-only: classifies the task, selects a workflow skill if one matches, ' +
      'and lists package references/assets without creating user artifacts.',
    maturity: 'beta',

    async execute(input: SkillRoutePreviewInput, context?: ToolExecutionContext): Promise<ToolResult> {
      if (!input || typeof input.prompt !== 'string' || input.prompt.trim() === '') {
        return {
          output: 'Error: prompt is required.',
          isError: true,
          metadata: { failureCategory: 'skill-route-preview:missing-prompt' },
        }
      }

      const result = await previewSkillRoute(input.prompt)

      // B1: mirror routing decision to skill-route.json ledger if a RunWorkspace exists.
      // Ledger write failures are surfaced in metadata but do not degrade the
      // read-only preview result.
      const runWorkspace = context?.taskState?.run.runWorkspace
      let ledgerWriteError: string | undefined
      if (runWorkspace) {
        try {
          await writeSkillRoute(runWorkspace.runDir, {
            selected: result.selectedSkill,
            candidates: result.selectedSkill ? [result.selectedSkill] : [],
            prompt: input.prompt,
            decidedAt: new Date().toISOString(),
            confidence: result.confidence,
            reason: result.reason,
            taskFamily: result.taskFamily,
            deliverableMode: result.deliverableMode,
            skillPath: result.skillPath,
            references: result.references,
            assets: result.assets,
          })
        } catch (err) {
          ledgerWriteError = err instanceof Error ? err.message : String(err)
        }
      }

      return {
        output: JSON.stringify(result, null, 2),
        isError: false,
        metadata: { result, ...(ledgerWriteError ? { ledgerWriteError } : {}) },
      }
    },
  }
}
