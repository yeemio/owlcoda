// Minimal earlyInput — only used by App.tsx for draining pre-render input
const _captured: string[] = []
let _capturing = false

export function startCapturingEarlyInput(): void { _capturing = true }
export function stopCapturingEarlyInput(): void { _capturing = false }
export function consumeEarlyInput(): string[] {
  const result = [..._captured]
  _captured.length = 0
  return result
}
export function lastGrapheme(text: string): string {
  return text.slice(-1)
}
