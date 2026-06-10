import { useCallback } from 'react'

type Notification = { key: string; text: string; priority?: string; timeoutMs?: number }

export function useNotifications() {
  return {
    addNotification: useCallback((_n: Notification) => {}, []),
    removeNotification: useCallback((_key: string) => {}, []),
  }
}
