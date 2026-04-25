export type TextHighlight = { start: number; end: number; color?: string }
export function applyHighlights(text: string, _highlights: TextHighlight[]): string { return text }
