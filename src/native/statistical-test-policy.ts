export type McNemarMethod = 'exact' | 'asymptotic'

export interface McNemarSelection {
  method: McNemarMethod
  discordantPairs: number
  reason: string
}

/**
 * The chi-square approximation is unreliable in sparse paired tables. Keep the
 * default exact and reject an explicitly requested approximation below the
 * conventional minimum of 25 discordant pairs.
 */
export function selectMcNemarMethod(
  discordant01: number,
  discordant10: number,
  requested: McNemarMethod = 'exact',
): McNemarSelection {
  for (const value of [discordant01, discordant10]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('McNemar discordant-pair counts must be non-negative integers')
    }
  }
  const discordantPairs = discordant01 + discordant10
  if (requested === 'asymptotic' && discordantPairs < 25) {
    throw new Error(`McNemar asymptotic test refused: ${discordantPairs} discordant pairs; use exact test below 25`)
  }
  return {
    method: requested,
    discordantPairs,
    reason: requested === 'exact'
      ? 'exact test is the safe default for paired binary outcomes'
      : 'asymptotic approximation allowed because discordant pairs >= 25',
  }
}
