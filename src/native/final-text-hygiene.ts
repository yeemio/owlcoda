export function dedupeFinalReportLines(text: string): string {
  const seen = new Set<string>()
  return text.split('\n').filter((line) => {
    const normalized = line.trim().replace(/\s+/g, ' ')
    if (normalized.length < 24) return true
    if (seen.has(normalized)) return false
    seen.add(normalized)
    return true
  }).join('\n')
}
