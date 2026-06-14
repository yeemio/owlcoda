// TS port of the de-vig methods (mirrors multi-agent/scripts/jingcai_pipeline.py
// devig()) plus edge/EV against our deterministic baseline. Used to turn
// user-provided 1X2 odds into market net probabilities and a value read.

export type DevigMethod = 'proportional' | 'power' | 'shin'

export interface DevigResult {
  method: DevigMethod
  probabilities: number[]
  parameter: number
  parameterName: 'overround' | 'k' | 'z'
}

function proportional(q: number[]): { probs: number[]; param: number } {
  const s = q.reduce((a, b) => a + b, 0)
  return { probs: q.map((qi) => qi / s), param: s - 1 }
}

function power(q: number[]): { probs: number[]; param: number } {
  let lo = 0
  let hi = 5
  let k = 1
  for (let it = 0; it < 200; it++) {
    k = 0.5 * (lo + hi)
    const s = q.reduce((a, qi) => a + qi ** k, 0)
    if (Math.abs(s - 1) < 1e-12) break
    if (s > 1) lo = k
    else hi = k
  }
  return { probs: q.map((qi) => qi ** k), param: k }
}

function shin(q: number[]): { probs: number[]; param: number } {
  const S = q.reduce((a, b) => a + b, 0)
  const probsAt = (z: number) =>
    q.map((qi) => ((z * z + 4 * (1 - z) * (qi * qi) / S) ** 0.5 - z) / (2 * (1 - z)))
  let lo = 0
  let hi = 1 - 1e-9
  let z = 0
  for (let it = 0; it < 200; it++) {
    z = 0.5 * (lo + hi)
    const s = probsAt(z).reduce((a, b) => a + b, 0)
    if (Math.abs(s - 1) < 1e-12) break
    if (s > 1) lo = z
    else hi = z
  }
  return { probs: probsAt(z), param: z }
}

// method: null/'auto' -> shin for 3-way, proportional for 2-way; falls back to
// proportional when there is no margin (sum of implied <= 1).
export function devig(odds: number[], method: DevigMethod | 'auto' | null = null): DevigResult | null {
  if (odds.length < 2 || odds.some((o) => !o || o <= 1)) return null
  const q = odds.map((o) => 1 / o)
  let chosen: DevigMethod = method && method !== 'auto' ? method : odds.length >= 3 ? 'shin' : 'proportional'
  if ((chosen === 'shin' || chosen === 'power') && q.reduce((a, b) => a + b, 0) <= 1) chosen = 'proportional'
  const r = chosen === 'shin' ? shin(q) : chosen === 'power' ? power(q) : proportional(q)
  const name = chosen === 'shin' ? 'z' : chosen === 'power' ? 'k' : 'overround'
  return { method: chosen, probabilities: r.probs, parameter: Math.round(r.param * 1e6) / 1e6, parameterName: name }
}

// edge = P_model - P_market (fair-price deviation, diagnostic, necessary not sufficient)
// EV   = P_model * odds - 1 (real stake expectation against the offered price)
// EV>0 (i.e. P_model > 1/odds, beating the vig) is the real betting threshold.
export interface ValueRead {
  outcome: 'home' | 'draw' | 'away'
  odds: number
  pModel: number
  pMarket: number
  edge: number
  ev: number
}

export function valueReads(
  modelProbs: { home: number; draw: number; away: number },
  marketProbs: number[],
  odds: number[],
): ValueRead[] {
  const keys: Array<'home' | 'draw' | 'away'> = ['home', 'draw', 'away']
  return keys.map((k, i) => {
    const pModel = modelProbs[k]
    const pMarket = marketProbs[i]
    return {
      outcome: k,
      odds: odds[i],
      pModel,
      pMarket,
      edge: Math.round((pModel - pMarket) * 1e4) / 1e4,
      ev: Math.round((pModel * odds[i] - 1) * 1e4) / 1e4,
    }
  })
}

// Conservative 1X2 decimal-odds extractor from free user text. Label-anchored:
// it captures the decimal odd adjacent to each 主胜/平/客胜 (or home/draw/away)
// label, so a handicap line in the same sentence (亚盘 -1.25) is ignored rather
// than mistaken for a 1X2 price, and integers/years/dates can't slip in.
// Returns null unless all three labelled prices are found and form a real book.
// a real decimal odd: 1-2 digits, dot, 1-2 decimals, not glued to other digits
const DEC = String.raw`(?<![\d.])(\d{1,2}\.\d{1,2})(?![\d.])`

function priceAfter(text: string, labels: string[]): number | null {
  for (const lab of labels) {
    // allow a few separators/words between the label and its price
    const m = text.match(new RegExp(lab + String.raw`[^\d\n]{0,6}` + DEC))
    if (m) {
      const n = Number(m[1])
      if (n >= 1.01 && n <= 101) return n
    }
  }
  return null
}

export function extractH2HOdds(text: string | undefined): number[] | null {
  if (!text) return null
  const h = priceAfter(text, ['主胜', '主', '\\bhome\\b'])
  const d = priceAfter(text, ['平局', '平', '\\bdraw\\b'])
  const a = priceAfter(text, ['客胜', '客', '\\baway\\b'])
  if (h == null || d == null || a == null) return null
  const triplet = [h, d, a]
  const s = triplet.reduce((acc, b) => acc + 1 / b, 0)
  if (s < 1.01 || s > 1.3) return null // realistic 3-way overround window (1%..30%)
  return triplet
}
