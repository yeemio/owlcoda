/**
 * Middleware type definitions for OwlCoda request pipeline.
 */

export interface RequestContext {
  requestId: string
  startTime: number
  method: string
  path: string
  model?: string
}
