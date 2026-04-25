/**
 * Skill document schema — defines the structure of learned skills.
 * Compatible with agentskills.io format and upstream SKILL.md convention.
 */

export interface SkillStep {
  order: number
  action: string
  detail?: string
}

export interface SkillPitfall {
  description: string
  mitigation: string
}

export interface SkillVerification {
  check: string
  expected: string
}

export interface SkillDocument {
  /** Unique ID (kebab-case, e.g., "fix-eslint-config") */
  id: string
  /** Human-readable name */
  name: string
  /** Short description of what this skill handles */
  description: string
  /** Step-by-step procedure */
  procedure: SkillStep[]
  /** Known pitfalls and how to avoid them */
  pitfalls: SkillPitfall[]
  /** How to verify the skill was applied correctly */
  verification: SkillVerification[]
  /** Tags for matching (e.g., ["typescript", "eslint", "config"]) */
  tags: string[]
  /** When this skill applies (natural language) */
  whenToUse: string
  /** Session ID this skill was synthesized from (null if manually created) */
  createdFrom?: string
  /** ISO timestamp */
  createdAt: string
  /** ISO timestamp */
  updatedAt: string
  /** How many times this skill has been matched and injected */
  useCount: number
  /** Synthesis mode used */
  synthesisMode: 'template' | 'llm' | 'manual'
  /** Version number (starts at 1, increments on update) */
  version?: number
  /** Parent skill ID this evolved from */
  parentId?: string
}

export interface SkillMetadata {
  id: string
  name: string
  description: string
  tags: string[]
  whenToUse: string
  useCount: number
  createdAt: string
  updatedAt: string
}

/**
 * Extract metadata from a full skill document.
 */
export function toMetadata(skill: SkillDocument): SkillMetadata {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: skill.tags ?? [],
    whenToUse: skill.whenToUse,
    useCount: skill.useCount,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  }
}

/**
 * Render a skill document as SKILL.md content (upstream-compatible).
 */
export function renderSkillMd(skill: SkillDocument): string {
  const lines: string[] = []

  lines.push(`# ${skill.name}`)
  lines.push('')
  lines.push(`> ${skill.description}`)
  lines.push('')

  if (skill.whenToUse) {
    lines.push(`## When to Use`)
    lines.push('')
    lines.push(skill.whenToUse)
    lines.push('')
  }

  if (skill.procedure && skill.procedure.length > 0) {
    lines.push(`## Procedure`)
    lines.push('')
    for (const step of skill.procedure) {
      lines.push(`${step.order}. **${step.action}**`)
      if (step.detail) lines.push(`   ${step.detail}`)
    }
    lines.push('')
  }

  if (skill.pitfalls && skill.pitfalls.length > 0) {
    lines.push(`## Pitfalls`)
    lines.push('')
    for (const p of skill.pitfalls) {
      lines.push(`- ⚠️ **${p.description}**`)
      lines.push(`  → ${p.mitigation}`)
    }
    lines.push('')
  }

  if (skill.verification && skill.verification.length > 0) {
    lines.push(`## Verification`)
    lines.push('')
    for (const v of skill.verification) {
      lines.push(`- [ ] ${v.check} → ${v.expected}`)
    }
    lines.push('')
  }

  if (skill.tags && skill.tags.length > 0) {
    lines.push(`## Tags`)
    lines.push('')
    lines.push(skill.tags.map(t => `\`${t}\``).join(', '))
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Validate a skill ID (kebab-case, 3-80 chars).
 */
export function isValidSkillId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/.test(id)
}

/**
 * Generate a skill ID from a name.
 */
export function nameToId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}
