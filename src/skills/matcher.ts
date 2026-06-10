/**
 * Skill matcher — TF-IDF based matching of incoming messages to learned skills.
 * Zero external dependencies. Uses term frequency–inverse document frequency.
 *
 * Flow: user message → tokenize → TF-IDF score against skill index → top-K results
 */

import type { SkillDocument } from './schema.js'

// ─── Internal type aliases (avoid nested generics that esbuild chokes on) ───
type StringSet = Set<string>
type TokenSetsMap = Map<string, StringSet[]>

// ─── Types ───

export interface MatchResult {
  skill: SkillDocument
  score: number
}

export interface SkillIndex {
  /** Number of documents in the index */
  docCount: number
  /** Inverse document frequency for each term */
  idf: Map<string, number>
  /** Per-skill TF-IDF vectors */
  vectors: Map<string, Map<string, number>>
  /** Reference to skills by ID */
  skills: Map<string, SkillDocument>
}

// ─── Tokenization ───

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was',
  'were', 'been', 'have', 'has', 'had', 'but', 'not', 'you', 'all',
  'can', 'her', 'his', 'one', 'our', 'out', 'use', 'how', 'its',
  'let', 'may', 'who', 'did', 'get', 'she', 'him', 'old', 'see',
  'now', 'way', 'each', 'make', 'like', 'than', 'them', 'then',
  'what', 'when', 'will', 'more', 'some', 'just', 'also', 'into',
  'over', 'such', 'take', 'only', 'very', 'much', 'here', 'there',
  'these', 'those', 'about', 'would', 'could', 'should', 'other',
  'which', 'their', 'after', 'before', 'being', 'between',
])

/**
 * Tokenize text into normalized terms.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w))
}

// ─── TF-IDF computation ───

/**
 * Compute term frequency (TF) for a list of tokens.
 * Uses raw frequency normalized by document length.
 */
function computeTf(tokens: string[]): Map<string, number> {
  const freq = new Map<string, number>()
  for (const t of tokens) {
    freq.set(t, (freq.get(t) ?? 0) + 1)
  }
  const len = tokens.length || 1
  const tf = new Map<string, number>()
  for (const [term, count] of freq) {
    tf.set(term, count / len)
  }
  return tf
}

/**
 * Compute IDF across all skill documents.
 */
function computeIdf(allTokenSets: TokenSetsMap): Map<string, number> {
  // Collect document frequency for each term
  const df = new Map<string, number>()
  const totalDocs = allTokenSets.size

  for (const [, tokenSets] of allTokenSets) {
    const uniqueTerms = new Set<string>()
    for (const ts of tokenSets) {
      for (const t of ts) uniqueTerms.add(t)
    }
    for (const t of uniqueTerms) {
      df.set(t, (df.get(t) ?? 0) + 1)
    }
  }

  const idf = new Map<string, number>()
  for (const [term, docFreq] of df) {
    idf.set(term, Math.log((totalDocs + 1) / (docFreq + 1)) + 1)
  }
  return idf
}

/**
 * Build a TF-IDF vector for a single document.
 */
function buildVector(tf: Map<string, number>, idf: Map<string, number>): Map<string, number> {
  const vec = new Map<string, number>()
  for (const [term, tfVal] of tf) {
    const idfVal = idf.get(term) ?? Math.log(2)
    vec.set(term, tfVal * idfVal)
  }
  return vec
}

// ─── Index building ───

/**
 * Extract all text from a skill document for indexing.
 */
function skillToText(skill: SkillDocument): string {
  const parts = [
    skill.name,
    skill.description,
    skill.whenToUse,
    // Tags are high-value, weight them by repeating
    ...skill.tags, ...skill.tags,
    ...(skill.procedure ?? []).map(s => `${s.action} ${s.detail ?? ''}`),
    ...(skill.pitfalls ?? []).map(p => `${p.description ?? ''} ${p.mitigation ?? ''}`),
  ]
  return parts.join(' ')
}

/**
 * Build a searchable index from a collection of skills.
 */
export function buildIndex(skills: SkillDocument[]): SkillIndex {
  if (skills.length === 0) {
    return {
      docCount: 0,
      idf: new Map(),
      vectors: new Map(),
      skills: new Map(),
    }
  }

  // Tokenize each skill
  const allTokenSets: TokenSetsMap = new Map()
  const allTfs = new Map<string, Map<string, number>>()
  const skillMap = new Map<string, SkillDocument>()

  for (const skill of skills) {
    const text = skillToText(skill)
    const tokens = tokenize(text)
    const tf = computeTf(tokens)
    allTfs.set(skill.id, tf)
    allTokenSets.set(skill.id, [new Set(tokens)])
    skillMap.set(skill.id, skill)
  }

  const idf = computeIdf(allTokenSets)

  const vectors = new Map<string, Map<string, number>>()
  for (const [id, tf] of allTfs) {
    vectors.set(id, buildVector(tf, idf))
  }

  return {
    docCount: skills.length,
    idf,
    vectors,
    skills: skillMap,
  }
}

// ─── Matching ───

/**
 * Compute cosine similarity between two sparse vectors.
 */
function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0
  let normA = 0
  let normB = 0

  for (const [term, val] of a) {
    normA += val * val
    const bVal = b.get(term)
    if (bVal !== undefined) dot += val * bVal
  }
  for (const [, val] of b) {
    normB += val * val
  }

  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Match a query against the skill index. Returns top-K results above threshold.
 * Score combines TF-IDF cosine similarity with usage frequency and recency boosts.
 */
export function matchSkills(
  query: string,
  index: SkillIndex,
  options: { topK?: number; threshold?: number; boostUsage?: boolean } = {},
): MatchResult[] {
  const { topK = 3, threshold = 0.05, boostUsage = true } = options

  if (index.docCount === 0) return []

  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return []

  const queryTf = computeTf(queryTokens)
  const queryVec = buildVector(queryTf, index.idf)

  const results: MatchResult[] = []
  const now = Date.now()

  for (const [id, docVec] of index.vectors) {
    const tfidfScore = cosineSimilarity(queryVec, docVec)
    if (tfidfScore < threshold) continue

    const skill = index.skills.get(id)
    if (!skill) continue

    let score = tfidfScore
    if (boostUsage && skill.useCount > 0) {
      // Usage boost: log(1 + useCount) * 0.1, capped at 0.5
      const usageBoost = Math.min(0.1 * Math.log(1 + skill.useCount), 0.5)
      // Recency boost: exponential decay with ~30-day half-life
      const daysSinceUpdate = (now - new Date(skill.updatedAt).getTime()) / 86400000
      const recencyBoost = 0.2 * Math.exp(-daysSinceUpdate / 30)
      score = tfidfScore * (1 + usageBoost + recencyBoost)
    }

    results.push({ skill, score })
  }

  results.sort((a, b) => b.score - a.score)
  return results.slice(0, topK)
}

// ─── Convenience ───

/**
 * One-shot match: build index + match in one call. For small skill sets.
 */
export function matchOne(
  query: string,
  skills: SkillDocument[],
  options?: { topK?: number; threshold?: number },
): MatchResult[] {
  const index = buildIndex(skills)
  return matchSkills(query, index, options)
}
