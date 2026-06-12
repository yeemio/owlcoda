import type { SeatRole } from '../api'

export interface RoleState {
  status: 'idle' | 'running' | 'done' | 'error'
  model: string
  raw: string
  output: any | null
  charCount: number
  startedAt: number | null
  durationMs: number | null
}

const idle = (): RoleState => ({ status: 'idle', model: '', raw: '', output: null, charCount: 0, startedAt: null, durationMs: null })

export const initialRoleStates = (): Record<SeatRole, RoleState> => ({
  recon: idle(),
  vision: idle(),
  pro: idle(),
  anti: idle(),
  judge: idle(),
})

export interface DimensionStatus {
  dimension: string
  source: string
  status: string
}
