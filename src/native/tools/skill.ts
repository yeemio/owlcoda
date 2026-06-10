/**
 * OwlCoda Native Skill Tool
 *
 * Dispatches on `action`:
 *   - list           → enumerate available skills (no `name` required)
 *   - info / show    → return metadata for one skill (`name` required)
 *   - run / get      → return the skill prompt body (`name` required)
 *
 * Single source of truth for skill registry: `src/skills/store.ts`'s
 * `loadAllSkills()`, which merges curated skills (project's `skills/`) and
 * learned skills (`~/.owlcoda/skills/`). Before 0.13.35 this tool walked
 * `.owlcoda/skills/` and `~/.owlcoda/skills/` directly and never saw the
 * curated library, so the `/skills` slash command would report e.g.
 * "64 curated skills available" while `Skill list` returned empty —
 * truth surface drift. The tool now reads the same registry the slash
 * command reads.
 *
 * Backwards compatible with the legacy `{ skill: '<name>' }` shape — when
 * neither `action` nor `name` is given but `skill` is, behave as
 * `{ action: 'run', name: <skill> }`.
 */

import type { NativeToolDef, ToolResult } from './types.js'
import { loadAllSkills } from '../../skills/store.js'
import { renderSkillMd } from '../../skills/schema.js'
import type { SkillDocument } from '../../skills/schema.js'

export type SkillAction = 'list' | 'run' | 'info' | 'get' | 'show'

export interface SkillInput {
  action?: SkillAction | string
  name?: string
  /** Legacy shorthand — equivalent to `{ action: 'run', name: skill }`. */
  skill?: string
  /** Args passed through to the skill (currently unused, reserved). */
  args?: Record<string, unknown>
}

/** Set of actions that require `name`. */
const NAME_REQUIRED_ACTIONS = new Set<string>(['run', 'info', 'get', 'show'])

/** All recognised actions. */
const KNOWN_ACTIONS = new Set<string>(['list', 'run', 'info', 'get', 'show'])

/** Match a skill by id or by case-insensitive name. */
function findSkill(skills: SkillDocument[], lookup: string): SkillDocument | undefined {
  const lower = lookup.toLowerCase()
  return skills.find(
    (s) => s.id === lookup || s.id.toLowerCase() === lower || s.name.toLowerCase() === lower,
  )
}

export function createSkillTool(_cwd?: string): NativeToolDef<SkillInput> {
  return {
    name: 'Skill',
    description:
      'Manage and execute registered skills (reusable prompt templates from ' +
      'curated and learned skill libraries).\n\n' +
      'Actions:\n' +
      '  • list           — enumerate available skills. No `name` required.\n' +
      '  • info | show    — return metadata for one skill. Requires `name`.\n' +
      '  • run  | get     — return the skill prompt body. Requires `name`.\n\n' +
      'Skills come from: curated library bundled with OwlCoda + learned ' +
      'skills under `~/.owlcoda/skills/` (synthesized from past sessions). ' +
      'A skill `name` may be either its id (kebab-case) or its display name.\n\n' +
      'Legacy shorthand `{ skill: "<name>" }` is accepted and maps to ' +
      '`{ action: "run", name: "<name>" }`.',

    async execute(input: SkillInput): Promise<ToolResult> {
      const rawInput: SkillInput = input ?? {}

      // Legacy shape: `{ skill: 'foo' }` → `{ action: 'run', name: 'foo' }`.
      let action: string = (rawInput.action ?? '').toString().trim().toLowerCase()
      let name: string | undefined = rawInput.name
      if (!action && !name && typeof rawInput.skill === 'string') {
        action = 'run'
        name = rawInput.skill
      }
      if (!action) action = 'run' // default to legacy behaviour
      if (!name && typeof rawInput.skill === 'string') name = rawInput.skill

      // Reject unknown actions up-front, before doing any FS work.
      if (!KNOWN_ACTIONS.has(action)) {
        return {
          output:
            `Error: unknown action "${action}". ` +
            `Expected one of: list, run, info, get, show.`,
          isError: true,
          // Split from the legacy umbrella category so legitimate negative
          // testing across distinct error paths (no-name vs bad-action vs
          // not-found) doesn't aggregate into a loop-guard trip — hostile-QA
          // against 0.13.38 hit exactly that false positive.
          metadata: { failureCategory: 'skill:invalid-action' },
        }
      }

      // Validate: name only required for actions that operate on a single skill.
      if (NAME_REQUIRED_ACTIONS.has(action)) {
        if (!name || typeof name !== 'string' || name.trim() === '') {
          return {
            output: `Error: skill name is required for action "${action}".`,
            isError: true,
            metadata: { failureCategory: 'skill:missing-name' },
          }
        }
      }

      // Single source of truth: same registry the /skills slash command reads.
      let allSkills: SkillDocument[]
      try {
        allSkills = await loadAllSkills()
      } catch (err) {
        return {
          output: `Error loading skill registry: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }

      if (action === 'list') {
        if (allSkills.length === 0) {
          return {
            output:
              '(no skills available)\n\n' +
              'No curated or learned skills are currently registered. Do NOT ' +
              'call Skill with action=run/info/get/show — they will fail. ' +
              'To populate the registry: install curated skills (bundled with ' +
              'OwlCoda releases) or generate learned skills from past sessions ' +
              '(see `owlcoda skills synth`).',
            isError: false,
            metadata: {
              skills: [],
              count: 0,
              failureCategory: 'skill:registry-empty',
            },
          }
        }
        const summary = allSkills.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          tags: s.tags,
          useCount: s.useCount,
        }))
        const lines = summary
          .map((s) => `- ${s.id} — ${s.description}${s.tags.length > 0 ? ` [${s.tags.join(', ')}]` : ''}`)
          .join('\n')
        return {
          output: `${summary.length} skill(s) available:\n${lines}`,
          isError: false,
          metadata: { skills: summary, count: summary.length },
        }
      }

      // Resolve skill by id (preferred) or name (case-insensitive fallback).
      const found = findSkill(allSkills, name as string)

      if (!found) {
        const availableIds = allSkills.map((s) => s.id)
        const sampleIds = availableIds.slice(0, 8).join(', ')
        const more = availableIds.length > 8 ? `, … (+${availableIds.length - 8} more)` : ''
        const tail = availableIds.length === 0
          ? '. The skill registry is empty — do not retry with another name; register a skill first or stop calling Skill run/info/get/show.'
          : `. Available ids: ${sampleIds}${more}`
        return {
          output: `Skill "${name}" not found${tail}`,
          isError: true,
          metadata: {
            available: availableIds,
            failureCategory: 'skill:not-found',
          },
        }
      }

      if (action === 'info' || action === 'show') {
        return {
          output:
            `ID: ${found.id}\n` +
            `Name: ${found.name}\n` +
            `Description: ${found.description}\n` +
            `When to use: ${found.whenToUse}\n` +
            `Tags: ${found.tags.join(', ') || '(none)'}\n` +
            `Steps: ${found.procedure.length}\n` +
            `Pitfalls: ${found.pitfalls.length}\n` +
            `Verifications: ${found.verification.length}\n` +
            `Use count: ${found.useCount}\n` +
            `Synthesis mode: ${found.synthesisMode}` +
            (found.version ? `\nVersion: ${found.version}` : ''),
          isError: false,
          metadata: {
            skill: {
              id: found.id,
              name: found.name,
              description: found.description,
              tags: found.tags,
              whenToUse: found.whenToUse,
              useCount: found.useCount,
              synthesisMode: found.synthesisMode,
            },
          },
        }
      }

      // Default / 'run' / 'get' — return the rendered skill body for the LLM.
      if (action === 'run' || action === 'get') {
        return {
          output: renderSkillMd(found),
          isError: false,
          metadata: {
            skill: {
              id: found.id,
              name: found.name,
              description: found.description,
              tags: found.tags,
              useCount: found.useCount,
            },
          },
        }
      }

      return {
        output:
          `Error: unknown action "${action}". ` +
          `Expected one of: list, run, info, get, show.`,
        isError: true,
        metadata: { failureCategory: 'skill:invalid-action' },
      }
    },
  }
}
