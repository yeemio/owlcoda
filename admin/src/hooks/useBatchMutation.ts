import { useCallback, useState } from 'react'
import type { BatchResponse, BatchResultItem } from '../api/types'

export type BatchStatus = 'idle' | 'selecting' | 'submitting' | 'success' | 'partial' | 'error'

export interface BatchState {
  status: BatchStatus
  results: BatchResultItem[]
  error: string | null
}

export interface UseBatchMutationResult<A extends unknown[]> extends BatchState {
  run: (...args: A) => Promise<BatchResponse | null>
  reset: () => void
  setSelecting: () => void
}

/**
 * Thin state machine for bulk operations.
 *
 * `success` = all items ok. `partial` = some ok, some failed.
 * `error` = request itself errored (4xx/5xx other than 207/422 which are
 * per-item data responses handled by the client).
 */
export function useBatchMutation<A extends unknown[]>(
  fn: (...args: A) => Promise<BatchResponse>,
): UseBatchMutationResult<A> {
  const [state, setState] = useState<BatchState>({ status: 'idle', results: [], error: null })

  const run = useCallback(async (...args: A): Promise<BatchResponse | null> => {
    setState({ status: 'submitting', results: [], error: null })
    try {
      const res = await fn(...args)
      const allOk = res.results.every(r => r.ok)
      const anyOk = res.results.some(r => r.ok)
      setState({
        status: allOk ? 'success' : anyOk ? 'partial' : 'error',
        results: res.results,
        error: null,
      })
      return res
    } catch (e) {
      setState({
        status: 'error',
        results: [],
        error: e instanceof Error ? e.message : String(e),
      })
      return null
    }
  }, [fn])

  const reset = useCallback(() => setState({ status: 'idle', results: [], error: null }), [])
  const setSelecting = useCallback(() => setState({ status: 'selecting', results: [], error: null }), [])

  return { ...state, run, reset, setSelecting }
}
