import { describe, expect, it } from 'vitest'
import {
  DESKTOP_PRODUCT_SHELL_LIVE_EVENT_TYPES,
  connectDesktopProductShellLiveEvents,
  createDesktopProductShellLiveAdapter,
  parseDesktopProductShellServerEvent,
} from '../../../src/native/app-server/desktop-product-shell-live-events.js'

describe('desktop product shell live events', () => {
  it('exposes command and diff event types as public product-shell live contract', () => {
    expect(DESKTOP_PRODUCT_SHELL_LIVE_EVENT_TYPES).toEqual(expect.arrayContaining([
      'command.started',
      'command.outputDelta',
      'command.completed',
      'diff.started',
      'diff.completed',
    ]))
  })

  it('folds live assistant/tool events and marks refresh-only events without terminal scraping', () => {
    const adapter = createDesktopProductShellLiveAdapter({
      scope: { projectId: 'project-1', threadId: 'thread-1' },
    })

    adapter.handleEvent({
      type: 'turn.started',
      projectId: 'project-1',
      threadId: 'thread-1',
      turnIndex: 3,
    })
    adapter.handleEvent({
      type: 'assistant.delta',
      projectId: 'project-1',
      threadId: 'thread-1',
      text: 'hello',
    })
    adapter.handleEvent({
      type: 'tool.started',
      projectId: 'project-1',
      threadId: 'thread-1',
      toolName: 'bash',
      input: { command: 'npm test' },
      toolUseId: 'tool-1',
      itemId: 'item-1',
      runtimeTurnId: 'runtime-turn-1',
    })
    adapter.handleEvent({
      type: 'tool.delta',
      projectId: 'project-1',
      threadId: 'thread-1',
      toolName: 'bash',
      lines: ['running'],
      delta: 'running',
      totalLines: 1,
      totalBytes: 7,
      elapsedMs: 10,
      toolUseId: 'tool-1',
      itemId: 'item-1',
      runtimeTurnId: 'runtime-turn-1',
    })
    adapter.handleEvent({
      type: 'approval.requested',
      projectId: 'project-1',
      threadId: 'thread-1',
      approvalId: 'approval-1',
      toolName: 'bash',
      approval: {
        id: 'approval-1',
        kind: 'tool_approval',
        source: 'live',
        projectId: 'project-1',
        threadId: 'thread-1',
        toolName: 'bash',
        input: {},
        status: 'pending',
        createdAt: 1,
      },
    })

    const snapshot = adapter.getSnapshot()

    expect(snapshot).toMatchObject({
      surface: 'desktop-product-shell-live-events',
      eventCount: 5,
      refreshNeeded: true,
      refreshReasons: ['approval.requested'],
      runtime: {
        activeTurnIndex: 3,
        items: [
          expect.objectContaining({
            kind: 'assistant',
            status: 'streaming',
            text: 'hello',
          }),
          expect.objectContaining({
            kind: 'tool',
            status: 'running',
            toolName: 'bash',
            output: 'running',
          }),
        ],
      },
    })
  })

  it('ignores out-of-scope events for runtime and refresh decisions', () => {
    const adapter = createDesktopProductShellLiveAdapter({
      scope: { projectId: 'project-1', threadId: 'thread-1' },
    })

    adapter.handleEvent({
      type: 'assistant.delta',
      projectId: 'project-1',
      threadId: 'other-thread',
      text: 'ignore',
    })
    adapter.handleEvent({
      type: 'approval.requested',
      projectId: 'project-1',
      threadId: 'other-thread',
      approvalId: 'approval-2',
      toolName: 'bash',
      approval: {
        id: 'approval-2',
        kind: 'tool_approval',
        source: 'live',
        projectId: 'project-1',
        threadId: 'other-thread',
        toolName: 'bash',
        input: {},
        status: 'pending',
        createdAt: 1,
      },
    })

    expect(adapter.getSnapshot()).toMatchObject({
      eventCount: 0,
      refreshNeeded: false,
      refreshReasons: [],
      runtime: {
        items: [],
      },
    })
  })

  it('connects an EventSource-like transport to product shell live events', () => {
    const eventSource = new FakeEventSource('unused')
    const snapshots: Array<ReturnType<ReturnType<typeof createDesktopProductShellLiveAdapter>['getSnapshot']>> = []
    const connection = connectDesktopProductShellLiveEvents({
      baseUrl: 'http://127.0.0.1:6199/',
      eventSourceFactory: url => {
        expect(url).toBe('http://127.0.0.1:6199/events')
        return eventSource
      },
      scope: { projectId: 'project-1', threadId: 'thread-1' },
      onSnapshot: snapshot => snapshots.push(snapshot),
    })

    expect(eventSource.registeredTypes()).toEqual(DESKTOP_PRODUCT_SHELL_LIVE_EVENT_TYPES)

    eventSource.emit('assistant.delta', {
      type: 'assistant.delta',
      projectId: 'project-1',
      threadId: 'thread-1',
      text: 'streamed',
    })

    expect(snapshots.at(-1)?.runtime.items).toEqual([
      expect.objectContaining({
        kind: 'assistant',
        text: 'streamed',
      }),
    ])

    connection.close()
    expect(eventSource.closed).toBe(true)
  })

  it('parses JSON server-sent event payloads and rejects malformed payloads', () => {
    expect(parseDesktopProductShellServerEvent({
      data: JSON.stringify({
        type: 'thread.updated',
        projectId: 'project-1',
        threadId: 'thread-1',
        turnCount: 2,
      }),
    })).toMatchObject({
      type: 'thread.updated',
      threadId: 'thread-1',
    })
    expect(() => parseDesktopProductShellServerEvent({ data: 'not json' })).toThrow('Invalid App Server event payload')
  })
})

class FakeEventSource {
  readonly url: string
  closed = false
  private readonly listeners = new Map<string, Array<(event: { data: string }) => void>>()

  constructor(url: string) {
    this.url = url
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    const existing = this.listeners.get(type) ?? []
    existing.push(listener)
    this.listeners.set(type, existing)
  }

  emit(type: string, payload: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(payload) })
    }
  }

  registeredTypes(): string[] {
    return [...this.listeners.keys()]
  }

  close(): void {
    this.closed = true
  }
}
