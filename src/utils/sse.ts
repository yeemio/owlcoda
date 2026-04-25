export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await readStreamChunkWithDeadline(reader, options)
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        if (trimmed.startsWith('event:')) continue
        if (trimmed.startsWith(':')) continue
        if (trimmed.startsWith('data: ')) {
          yield trimmed.slice(6)
        } else if (trimmed.startsWith('data:')) {
          yield trimmed.slice(5)
        }
      }
    }

    if (buffer.trim()) {
      const trimmed = buffer.trim()
      if (trimmed.startsWith('data: ')) yield trimmed.slice(6)
      else if (trimmed.startsWith('data:')) yield trimmed.slice(5)
    }
  } finally {
    reader.releaseLock()
  }
}

export async function readStreamChunkWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const timeoutMs = options.timeoutMs
  const signal = options.signal
  if ((!timeoutMs || timeoutMs <= 0) && !signal) return reader.read()

  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn()
    }

    const cancelReader = (reason: Error): void => {
      reader.cancel(reason).catch(() => {})
    }

    const onAbort = (): void => {
      const err = new Error('Request aborted')
      err.name = 'AbortError'
      cancelReader(err)
      settle(() => reject(err))
    }

    if (signal?.aborted) {
      onAbort()
      return
    }

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        const err = new Error(`Stream read timed out after ${timeoutMs}ms`)
        err.name = 'TimeoutError'
        cancelReader(err)
        settle(() => reject(err))
      }, timeoutMs)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    reader.read().then(
      result => settle(() => resolve(result)),
      err => settle(() => reject(err)),
    )
  })
}
