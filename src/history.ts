const _history: string[] = []
export function addToHistory(input: string): void {
  if (input.trim()) _history.push(input)
}
export function getHistory(): string[] { return _history }
