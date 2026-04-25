// Minimal envUtils.ts — only exports isEnvTruthy for ink/
export function isEnvTruthy(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes'
}
