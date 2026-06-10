/**
 * Skill Router Preview
 *
 * Classifies a user task and previews which workflow skill would be loaded.
 * This module is intentionally read-only: it may inspect skill packages to
 * list references/assets, but it never creates user artifacts.
 */

import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import type { SkillDocument } from './schema.js'
import { getCuratedSkillsDir } from './curated.js'
import { loadAllSkills } from './store.js'
import { getOwlcodaDir } from '../paths.js'

export type SkillRouterTaskFamily =
  | 'deck'
  | 'code'
  | 'image_asset'
  | 'research'
  | 'data_report'
  | 'release'
  | 'general'

export type SkillRouterDeliverableMode =
  | 'read_only_review'
  | 'text_deliverable'
  | 'file_artifact_delivery'
  | 'code_change'
  | 'command_job'
  | 'mixed_unknown'

export type SkillRouterConfidence = 'low' | 'medium' | 'high'

export interface TaskIntentPreview {
  taskFamily: SkillRouterTaskFamily
  deliverableMode: SkillRouterDeliverableMode
  confidence: SkillRouterConfidence
  reason: string
}

export interface SkillRouterPreview extends TaskIntentPreview {
  selectedSkill: string | null
  skillPath: string | null
  references: string[]
  assets: string[]
}

export interface SkillRouterPreviewOptions {
  /** Optional in-memory skill registry for tests or callers with a preloaded store. */
  skills?: SkillDocument[]
  /** Optional async registry loader. Ignored when `skills` is provided. */
  loadSkills?: () => Promise<SkillDocument[]>
  /** Roots containing `<skill-id>/SKILL.md` package directories. */
  skillRoots?: string[]
  /** Explicit path overrides. Values may be package dirs or SKILL.md paths. */
  skillPaths?: Record<string, string>
}

const GUIZANG_PPT_SKILL_ID = 'guizang-ppt-skill'

const READONLY_REVIEW_PATTERNS = [
  /只读评审/i,
  /只读\s*review/i,
  /read[-\s]?only\s+review/i,
  /review\s+only/i,
  /仅评审/i,
  /不要修改/i,
  /do\s+not\s+modify/i,
  /without\s+(?:making\s+)?changes/i,
] as const

const REVIEW_SIGNAL_PATTERNS = [
  /评审/i,
  /审查/i,
  /review/i,
  /code\s+review/i,
  /风险/i,
] as const

const NO_ARTIFACT_PATTERNS = [
  /不要创建产物/i,
  /不要创建文件/i,
  /只在聊天里/i,
  /only\s+in\s+chat/i,
  /chat\s+only/i,
] as const

const DECK_PATTERNS = [
  /\bhtml\s*ppt\b/i,
  /\bppt\b/i,
  /\bdeck\b/i,
  /\bslides?\b/i,
  /\bpresentation\b/i,
  /网页\s*ppt/i,
  /横向翻页/i,
  /演示文稿/i,
  /幻灯片/i,
] as const

const DECK_PRODUCTION_PATTERNS = [
  /生成/i,
  /制作/i,
  /重构成/i,
  /转成/i,
  /转换成/i,
  /输出到/i,
  /输出\s+build-notes/i,
  /写(?:一份|成)?/i,
  /\bgenerate\b/i,
  /\bcreate\b/i,
  /\bbuild\b/i,
  /\bmake\b/i,
  /\bconvert\b/i,
  /\bproduce\b/i,
] as const

const FILE_OUTPUT_PATTERNS = [
  /输出到/i,
  /输出目录/i,
  /同目录输出/i,
  /写入/i,
  /生成文件/i,
  /build-notes\.md/i,
  /\.html\b/i,
  /\/tmp\//i,
  /\boutput\s+(?:to|dir|directory|path)\b/i,
] as const

const SOURCE_CODE_PATTERNS = [
  /\bsrc\//i,
  /\btests?\//i,
  /\bpackage\.json\b/i,
  /\btsconfig(?:\.\w+)?\.json\b/i,
  /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|sql)\b/i,
] as const

const CODE_EDIT_PATTERNS = [
  /修改/i,
  /修复/i,
  /实现/i,
  /加单测/i,
  /补单测/i,
  /补测试/i,
  /重构/i,
  /\bfix\b/i,
  /\bimplement\b/i,
  /\bpatch\b/i,
  /\bedit\b/i,
  /\brefactor\b/i,
  /\btest\b/i,
] as const

const IMAGE_PATTERNS = [
  /图片/i,
  /配图/i,
  /素材/i,
  /\bimage\b/i,
  /\basset\b/i,
  /\bmockup\b/i,
] as const

const RESEARCH_PATTERNS = [
  /调研/i,
  /研究/i,
  /资料/i,
  /\bresearch\b/i,
  /\bsurvey\b/i,
] as const

const DATA_REPORT_PATTERNS = [
  /数据分析/i,
  /报表/i,
  /图表/i,
  /\bcsv\b/i,
  /\bspreadsheet\b/i,
  /\bdata\s+report\b/i,
] as const

const RELEASE_PATTERNS = [
  /发布/i,
  /上线/i,
  /\brelease\b/i,
  /\bdeploy\b/i,
  /\bnpm\b/i,
] as const

const SKIP_SCAN_DIRS = new Set(['.git', 'node_modules', 'dist'])

function hasAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

function toPosixPath(path: string): string {
  return path.split('\\').join('/')
}

export function classifyTaskIntent(prompt: string): TaskIntentPreview {
  const text = prompt.trim()
  if (!text) {
    return {
      taskFamily: 'general',
      deliverableMode: 'mixed_unknown',
      confidence: 'low',
      reason: 'Empty prompt; no routeable task intent detected',
    }
  }

  const reviewSignal = hasAny(text, REVIEW_SIGNAL_PATTERNS)
  const readOnlySignal = hasAny(text, READONLY_REVIEW_PATTERNS) || (reviewSignal && hasAny(text, NO_ARTIFACT_PATTERNS))
  const sourceCodeSignal = hasAny(text, SOURCE_CODE_PATTERNS)
  const codeEditSignal = hasAny(text, CODE_EDIT_PATTERNS)
  const deckSignal = hasAny(text, DECK_PATTERNS)
  const deckProductionSignal = hasAny(text, DECK_PRODUCTION_PATTERNS)
  const fileOutputSignal = hasAny(text, FILE_OUTPUT_PATTERNS)

  if (reviewSignal && readOnlySignal) {
    return {
      taskFamily: sourceCodeSignal ? 'code' : deckSignal ? 'deck' : 'general',
      deliverableMode: 'read_only_review',
      confidence: 'high',
      reason: 'Read-only review request; workflow artifact skills are suppressed',
    }
  }

  if (sourceCodeSignal && codeEditSignal) {
    return {
      taskFamily: 'code',
      deliverableMode: 'code_change',
      confidence: 'high',
      reason: deckSignal
        ? 'Code edit request targets source files, so deck workflow skills are suppressed'
        : 'Code edit request targets source files',
    }
  }

  if (deckSignal && (deckProductionSignal || fileOutputSignal)) {
    return {
      taskFamily: 'deck',
      deliverableMode: 'file_artifact_delivery',
      confidence: fileOutputSignal ? 'high' : 'medium',
      reason: fileOutputSignal
        ? 'HTML PPT/deck generation request with explicit file output'
        : 'Deck generation request',
    }
  }

  if (hasAny(text, IMAGE_PATTERNS) && (hasAny(text, DECK_PRODUCTION_PATTERNS) || fileOutputSignal)) {
    return {
      taskFamily: 'image_asset',
      deliverableMode: fileOutputSignal ? 'file_artifact_delivery' : 'text_deliverable',
      confidence: 'medium',
      reason: 'Image or asset generation request',
    }
  }

  if (hasAny(text, DATA_REPORT_PATTERNS)) {
    return {
      taskFamily: 'data_report',
      deliverableMode: fileOutputSignal ? 'file_artifact_delivery' : 'text_deliverable',
      confidence: 'medium',
      reason: 'Data analysis/report request',
    }
  }

  if (hasAny(text, RELEASE_PATTERNS)) {
    return {
      taskFamily: 'release',
      deliverableMode: 'command_job',
      confidence: 'medium',
      reason: 'Release or deployment operation request',
    }
  }

  if (hasAny(text, RESEARCH_PATTERNS)) {
    return {
      taskFamily: 'research',
      deliverableMode: fileOutputSignal ? 'file_artifact_delivery' : 'text_deliverable',
      confidence: 'medium',
      reason: 'Research or survey request',
    }
  }

  return {
    taskFamily: 'general',
    deliverableMode: 'text_deliverable',
    confidence: 'low',
    reason: 'No workflow-specific route matched',
  }
}

export async function previewSkillRoute(
  prompt: string,
  options: SkillRouterPreviewOptions = {},
): Promise<SkillRouterPreview> {
  const intent = classifyTaskIntent(prompt)
  const skills = options.skills ?? (options.loadSkills ? await options.loadSkills() : await loadAllSkills())

  const selected = selectWorkflowSkill(intent, skills)
  const skillPath = selected ? await resolveSkillPath(selected.id, options) : null
  const [references, assets] = skillPath
    ? await Promise.all([
        scanPackageSubdir(skillPath, 'references'),
        scanPackageSubdir(skillPath, 'assets'),
      ])
    : [[], []]

  return {
    ...intent,
    selectedSkill: selected?.id ?? null,
    skillPath,
    references,
    assets,
    confidence: routeConfidence(intent, selected),
    reason: routeReason(intent, selected),
  }
}

function selectWorkflowSkill(intent: TaskIntentPreview, skills: SkillDocument[]): SkillDocument | null {
  if (intent.taskFamily !== 'deck' || intent.deliverableMode !== 'file_artifact_delivery') {
    return null
  }

  return skills.find((skill) => skill.id === GUIZANG_PPT_SKILL_ID || skill.name === GUIZANG_PPT_SKILL_ID) ?? null
}

function routeConfidence(intent: TaskIntentPreview, selected: SkillDocument | null): SkillRouterConfidence {
  if (selected) return intent.confidence === 'low' ? 'medium' : intent.confidence
  if (intent.taskFamily === 'deck' && intent.deliverableMode === 'file_artifact_delivery') return 'medium'
  return intent.confidence
}

function routeReason(intent: TaskIntentPreview, selected: SkillDocument | null): string {
  if (selected) {
    return `${intent.reason}; selected ${selected.id} as the registered HTML PPT workflow skill`
  }
  if (intent.taskFamily === 'deck' && intent.deliverableMode === 'file_artifact_delivery') {
    return `${intent.reason}; ${GUIZANG_PPT_SKILL_ID} was not found in the skill registry`
  }
  return intent.reason
}

async function resolveSkillPath(id: string, options: SkillRouterPreviewOptions): Promise<string | null> {
  const explicit = options.skillPaths?.[id]
  if (explicit) {
    const explicitSkillPath = basename(explicit).toLowerCase() === 'skill.md' ? explicit : join(explicit, 'SKILL.md')
    if (existsSync(explicitSkillPath)) return explicitSkillPath
  }

  const roots = options.skillRoots ?? defaultSkillRoots()
  for (const root of roots) {
    const direct = join(root, id, 'SKILL.md')
    if (existsSync(direct)) return direct

    const nested = await findSkillMdById(root, id)
    if (nested) return nested
  }

  return null
}

function defaultSkillRoots(): string[] {
  return Array.from(new Set([
    join(getOwlcodaDir(), 'skills'),
    getCuratedSkillsDir(),
  ]))
}

async function findSkillMdById(root: string, id: string, depth: number = 0): Promise<string | null> {
  if (!existsSync(root) || depth > 8) return null

  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return null
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || SKIP_SCAN_DIRS.has(entry.name)) continue

    const dir = join(root, entry.name)
    if (entry.name === id) {
      const candidate = join(dir, 'SKILL.md')
      if (existsSync(candidate)) return candidate
    }

    const nested = await findSkillMdById(dir, id, depth + 1)
    if (nested) return nested
  }

  return null
}

async function scanPackageSubdir(skillPath: string, subdir: 'references' | 'assets'): Promise<string[]> {
  const packageRoot = dirname(skillPath)
  const root = join(packageRoot, subdir)
  if (!existsSync(root)) return []

  const files: string[] = []
  await collectFiles(root, packageRoot, files)
  return files.sort((a, b) => a.localeCompare(b))
}

async function collectFiles(currentDir: string, packageRoot: string, files: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(currentDir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP_SCAN_DIRS.has(entry.name)) continue

    const fullPath = join(currentDir, entry.name)
    if (entry.isDirectory()) {
      await collectFiles(fullPath, packageRoot, files)
    } else if (entry.isFile()) {
      files.push(toPosixPath(relative(packageRoot, fullPath)))
    }
  }
}
