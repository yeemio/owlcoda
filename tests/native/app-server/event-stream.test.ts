import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createAppServerEventBus } from '../../../src/native/app-server/event-stream.js'
import { createAppServer, listenAppServer } from '../../../src/native/app-server/http-server.js'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close(error => error ? reject(error) : resolve())
  })))
})

describe('app-server structured event stream', () => {
  it('publishes typed events to subscribers without terminal text parsing', () => {
    const bus = createAppServerEventBus({ now: () => '2026-07-11T00:00:00.000Z' })
    const received: unknown[] = []
    const unsubscribe = bus.subscribe(event => received.push(event))

    bus.publish({
      type: 'runtimeRail.updated',
      projectId: 'owlcoda',
      freshness: 'missing',
      source: 'not_connected',
    })
    unsubscribe()
    bus.publish({
      type: 'project.updated',
      projectId: 'ignored-after-unsubscribe',
    })

    expect(received).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        eventId: 'owlcoda:1',
        sequence: 1,
        occurredAt: '2026-07-11T00:00:00.000Z',
        type: 'runtimeRail.updated',
        projectId: 'owlcoda',
        workspaceId: 'owlcoda',
        freshness: 'missing',
        source: 'not_connected',
        payload: { freshness: 'missing', source: 'not_connected' },
        artifactRefs: [],
      }),
    ])
  })

  it('replays retained events after a sequence and reports an unavailable replay window', () => {
    const bus = createAppServerEventBus({ maxRetainedEvents: 2 })
    bus.publish({ type: 'project.updated', projectId: 'project-1' })
    bus.publish({ type: 'project.updated', projectId: 'project-2' })
    bus.publish({ type: 'project.updated', projectId: 'project-3' })

    expect(bus.replay(1)).toMatchObject({
      available: true,
      events: [
        expect.objectContaining({ sequence: 2, projectId: 'project-2' }),
        expect.objectContaining({ sequence: 3, projectId: 'project-3' }),
      ],
      cursor: {
        oldestAvailableSequence: 2,
        latestSequence: 3,
        afterSequence: 3,
      },
    })
    expect(bus.replay(0)).toMatchObject({
      available: false,
      events: [],
      cursor: {
        oldestAvailableSequence: 2,
        latestSequence: 3,
        afterSequence: 3,
      },
    })
  })

  it('streams events over GET /events as server-sent events', async () => {
    const bus = createAppServerEventBus()
    const server = createAppServer({ projectRoot: process.cwd(), eventBus: bus })
    await listenAppServer(server, { host: '127.0.0.1', port: 0 })
    servers.push(server)

    const response = await fetch(`${baseUrl(server)}/events`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    bus.publish({
      type: 'runtimeRail.updated',
      projectId: 'owlcoda',
      freshness: 'missing',
      source: 'not_connected',
    })

    const reader = response.body?.getReader()
    if (!reader) throw new Error('missing response body reader')
    const chunk = await readUntilText(reader, 'event: runtimeRail.updated')

    expect(chunk).toContain('event: runtimeRail.updated')
    expect(chunk).toContain('id: 1')
    expect(chunk).toContain('"sequence":1')
    expect(chunk).toContain('"projectId":"owlcoda"')
    expect(chunk).toContain('"freshness":"missing"')
    await reader.cancel()
  })

  it('replays missed events from Last-Event-ID before live events', async () => {
    const bus = createAppServerEventBus()
    bus.publish({ type: 'project.updated', projectId: 'project-1' })
    bus.publish({ type: 'project.updated', projectId: 'project-2' })
    const server = createAppServer({ projectRoot: process.cwd(), eventBus: bus })
    await listenAppServer(server, { host: '127.0.0.1', port: 0 })
    servers.push(server)

    const response = await fetch(`${baseUrl(server)}/events`, {
      headers: { 'last-event-id': '1' },
    })
    expect(response.status).toBe(200)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('missing response body reader')
    const chunk = await readUntilText(reader, '"projectId":"project-2"')

    expect(chunk).not.toContain('"projectId":"project-1"')
    expect(chunk).toContain('id: 2')
    expect(chunk).toContain('"projectId":"project-2"')
    await reader.cancel()
  })
})

async function readUntilText(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error('timed out waiting for event chunk')), 1000)
  })
  const read = (async () => {
    let text = ''
    while (!text.includes(needle)) {
      const result = await reader.read()
      if (result.done) break
      text += new TextDecoder().decode(result.value ?? new Uint8Array())
    }
    return text
  })()
  return Promise.race([read, timeout])
}

function baseUrl(server: Server): string {
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('server did not bind to a TCP address')
  }
  return `http://127.0.0.1:${address.port}`
}
