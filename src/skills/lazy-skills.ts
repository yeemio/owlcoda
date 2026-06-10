/**
 * Lazy-skills (S6) — the "correctness lever".
 *
 * Today injection picks the top-2 TF-IDF matches and injects their FULL bodies
 * every turn; the model never sees the other 63 skills. Lazy mode instead
 * injects a name-only CATALOG of all skills (cheap, stable, cacheable in the
 * system-prompt prefix) and lets the model pull a body on demand via
 * loadSkill(id). The win is less token spend AND better selection — the model
 * chooses the right skill from the full set rather than top-2 retrieval guessing
 * (and third-party skills scale in for free).
 *
 * Opt-in via OWLCODA_LAZY_SKILLS; default OFF preserves the current eager
 * injection until the trigger-rate data says lazy is at least as good.
 */

export interface SkillCatalogEntry {
  id: string
  name: string
  description: string
  whenToUse?: string
}

/** Render the name-only skill catalog injected in lazy mode. Pure.
 *  On-demand loading reuses the existing Skill tool (no new tool needed):
 *  Skill({action:"run", name:"<id>"}) returns a skill's full body. */
export function buildSkillCatalog(skills: readonly SkillCatalogEntry[]): string {
  if (skills.length === 0) return 'No skills are available.'
  const lines = skills.map(s => {
    const when = s.whenToUse ? ` (use when: ${s.whenToUse})` : ''
    return `- ${s.id} — ${s.name}: ${s.description}${when}`
  })
  return [
    'Available skills. Before applying one, load its full guidance with the Skill ' +
      'tool: Skill({action:"run", name:"<id>"}). Pick by relevance:',
    ...lines,
  ].join('\n')
}

/** Opt-in (default OFF). Lazy injection is a behavior change → off until data. */
export function isLazySkillsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['OWLCODA_LAZY_SKILLS']
  if (raw === undefined) return false
  return new Set(['1', 'true', 'yes', 'on', 'enable', 'enabled']).has(raw.trim().toLowerCase())
}
