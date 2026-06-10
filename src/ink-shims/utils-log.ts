// Minimal log.ts — only exports logError for ink/
export function logError(contextOrError: string | Error, error?: unknown): void {
  if (process.env['OWLCODA_TRACE']) {
    if (error !== undefined) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`[${contextOrError}] ${msg}`)
    } else {
      const msg = contextOrError instanceof Error ? contextOrError.message : String(contextOrError)
      console.error(msg)
    }
  }
}
