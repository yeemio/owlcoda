import { useCallback, useEffect, useState } from 'react'
import { fetchSnapshot } from '../api/client'
import type { ModelTruthSnapshot } from '../api/types'

interface State {
  snapshot: ModelTruthSnapshot | null
  error: string | null
  loading: boolean
  lastFetchedAt: number | null
}

export interface UseSnapshotResult extends State {
  refresh: () => void
  /**
   * Apply a snapshot fetched out-of-band (e.g. returned in the mutation
   * response). Skips the extra GET roundtrip while still keeping
   * `lastFetchedAt` accurate so the age indicator moves.
   */
  applyFreshSnapshot: (snapshot: ModelTruthSnapshot) => void
}

export interface UseSnapshotOptions {
  /** When false, the hook does not auto-fetch on mount. Caller must call
   *  refresh() explicitly. Used by App to defer the first snapshot until
   *  auth bootstrap completes (avoids "Missing admin session" race where
   *  snapshot fires before the exchange cookie is set). */
  autoFetch?: boolean
}

export function useSnapshot(options: UseSnapshotOptions = {}): UseSnapshotResult {
  const autoFetch = options.autoFetch ?? true
  const [state, setState] = useState<State>({
    snapshot: null,
    error: null,
    loading: autoFetch,
    lastFetchedAt: null,
  })

  const refresh = useCallback(() => {
    setState(s => ({ ...s, loading: true, error: null }))
    fetchSnapshot()
      .then(res => {
        setState({
          snapshot: res.snapshot,
          error: null,
          loading: false,
          lastFetchedAt: Date.now(),
        })
      })
      .catch((e: Error) => {
        setState(s => ({
          ...s,
          loading: false,
          error: e.message,
        }))
      })
  }, [])

  const applyFreshSnapshot = useCallback((snapshot: ModelTruthSnapshot) => {
    setState({
      snapshot,
      error: null,
      loading: false,
      lastFetchedAt: Date.now(),
    })
  }, [])

  useEffect(() => {
    if (autoFetch) refresh()
  }, [autoFetch, refresh])

  return { ...state, refresh, applyFreshSnapshot }
}
