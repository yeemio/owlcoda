import { describe, expect, it } from 'vitest'
import { consumeStream } from '../../src/native/protocol/stream.js'

describe('native protocol stream abort gating', () => {
  it('drops late text chunks after abort', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'event: message_start\n' +
          'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n' +
          'event: content_block_delta\n' +
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n',
        ))

        setTimeout(() => {
          try {
            controller.enqueue(encoder.encode(
              'event: content_block_delta\n' +
              'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}\n\n',
            ))
            controller.close()
          } catch {
            // Stream was cancelled by abort.
          }
        }, 25)
      },
    })

    const ac = new AbortController()
    const deltas: string[] = []
    setTimeout(() => ac.abort(), 10)

    const result = await consumeStream(
      stream,
      (text) => deltas.push(text),
      undefined,
      undefined,
      ac.signal,
    )

    expect(deltas).toEqual(['hello'])
    expect(result.text).toBe('hello')
  })

  it('throws a stream interruption error on premature close', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'event: message_start\n' +
          'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
        ))
        controller.close()
      },
    })

    await expect(consumeStream(stream)).rejects.toThrow('stream closed before first token')
  })

  it('distinguishes post-token stream interruption from pre-first-token close', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'event: message_start\n' +
          'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n' +
          'event: content_block_delta\n' +
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
        ))
        controller.close()
      },
    })

    await expect(consumeStream(stream)).rejects.toThrow('stream closed before completion')
  })

  it('consumes relay SSE frames without spaces after field colons', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'event:message_start\n' +
          'data:{"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n' +
          'event:content_block_start\n' +
          'data:{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
          'event:content_block_delta\n' +
          'data:{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n' +
          'event:message_delta\n' +
          'data:{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
          'event:message_stop\n' +
          'data:{"type":"message_stop"}\n\n',
        ))
        controller.close()
      },
    })

    const deltas: string[] = []
    const result = await consumeStream(stream, (text) => deltas.push(text))

    expect(deltas).toEqual(['OK'])
    expect(result.text).toBe('OK')
    expect(result.stopReason).toBe('end_turn')
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1 })
  })
})
