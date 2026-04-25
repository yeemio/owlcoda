/**
 * SSE parser unit tests — parseSSEStream line protocol handling.
 */
import { describe, it, expect } from 'vitest'
import { parseSSEStream } from '../src/utils/sse.js'

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]))
      } else {
        controller.close()
      }
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const results: string[] = []
  for await (const data of parseSSEStream(stream)) {
    results.push(data)
  }
  return results
}

describe('parseSSEStream', () => {
  it('yields data from basic SSE lines', async () => {
    const stream = makeStream(['data: {"type":"ping"}\n\ndata: {"type":"done"}\n\n'])
    const results = await collect(stream)
    expect(results).toEqual(['{"type":"ping"}', '{"type":"done"}'])
  })

  it('accumulates across multiple chunks', async () => {
    const stream = makeStream(['data: hel', 'lo\ndata: world\n'])
    const results = await collect(stream)
    expect(results).toEqual(['hello', 'world'])
  })

  it('skips event: lines', async () => {
    const stream = makeStream(['event: message_start\ndata: {"ok":true}\n\n'])
    const results = await collect(stream)
    expect(results).toEqual(['{"ok":true}'])
  })

  it('skips :comment lines', async () => {
    const stream = makeStream([':keepalive\ndata: real\n\n'])
    const results = await collect(stream)
    expect(results).toEqual(['real'])
  })

  it('handles data: without space after colon', async () => {
    const stream = makeStream(['data:no-space\n\n'])
    const results = await collect(stream)
    expect(results).toEqual(['no-space'])
  })

  it('yields nothing from empty stream', async () => {
    const stream = makeStream([])
    const results = await collect(stream)
    expect(results).toEqual([])
  })

  it('yields nothing from blank lines only', async () => {
    const stream = makeStream(['\n\n\n'])
    const results = await collect(stream)
    expect(results).toEqual([])
  })

  it('flushes trailing data in buffer', async () => {
    // No trailing newline — data is in buffer at stream end
    const stream = makeStream(['data: trailing'])
    const results = await collect(stream)
    expect(results).toEqual(['trailing'])
  })

  it('handles interleaved blank lines between events', async () => {
    const stream = makeStream(['data: a\n\n\n\ndata: b\n\n'])
    const results = await collect(stream)
    expect(results).toEqual(['a', 'b'])
  })

  it('handles multiple data lines without blank separator', async () => {
    const stream = makeStream(['data: first\ndata: second\n\n'])
    const results = await collect(stream)
    expect(results).toEqual(['first', 'second'])
  })

  it('handles chunk split mid-keyword', async () => {
    const stream = makeStream(['da', 'ta: split\n\n'])
    const results = await collect(stream)
    expect(results).toEqual(['split'])
  })

  it('ignores non-data non-event non-comment lines', async () => {
    const stream = makeStream(['id: 123\nretry: 5000\ndata: real\n\n'])
    const results = await collect(stream)
    expect(results).toEqual(['real'])
  })
})
