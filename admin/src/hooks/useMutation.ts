import { useCallback, useRef, useState } from 'react'

export type MutationStatus = 'idle' | 'submitting' | 'success' | 'error'

export interface MutationState<T> {
  status: MutationStatus
  data: T | null
  error: string | null
}

export interface UseMutationResult<A extends unknown[], T> extends MutationState<T> {
  run: (...args: A) => Promise<T | null>
  reset: () => void
}

export function useMutation<A extends unknown[], T>(
  fn: (...args: A) => Promise<T>,
): UseMutationResult<A, T> {
  const [state, setState] = useState<MutationState<T>>({ status: 'idle', data: null, error: null })
  const aliveRef = useRef(true)

  const run = useCallback(
    async (...args: A): Promise<T | null> => {
      setState({ status: 'submitting', data: null, error: null })
      try {
        const data = await fn(...args)
        if (aliveRef.current) setState({ status: 'success', data, error: null })
        return data
      } catch (e) {
        if (aliveRef.current) {
          setState({ status: 'error', data: null, error: e instanceof Error ? e.message : String(e) })
        }
        return null
      }
    },
    [fn],
  )

  const reset = useCallback(() => setState({ status: 'idle', data: null, error: null }), [])

  return { ...state, run, reset }
}
