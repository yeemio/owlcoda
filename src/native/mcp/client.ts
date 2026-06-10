/**
 * MCP stdio transport client.
 *
 * Implements JSON-RPC 2.0 over stdin/stdout to communicate
 * with MCP servers. Clean-room implementation based on public spec.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  MCPServerConfig,
  MCPInitializeResult,
  MCPServerCapabilities,
  MCPTool,
  MCPToolCallResult,
  MCPResource,
  MCPResourceContent,
} from './types.js'

const PROTOCOL_VERSION = '2024-11-05'
const CONNECT_TIMEOUT_MS = 15_000
const REQUEST_TIMEOUT_MS = 30_000

interface PendingRequest {
  resolve: (val: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class MCPClient extends EventEmitter {
  private proc: ChildProcess | null = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private readBuffer = ''
  private _connected = false
  private _capabilities: MCPServerCapabilities | undefined
  private _serverInfo: { name: string; version: string } | undefined

  constructor(
    readonly serverName: string,
    private config: MCPServerConfig,
  ) {
    super()
  }

  get connected(): boolean {
    return this._connected
  }
  get capabilities(): MCPServerCapabilities | undefined {
    return this._capabilities
  }
  get serverInfo(): { name: string; version: string } | undefined {
    return this._serverInfo
  }

  /** Spawn the MCP server process and complete the initialize handshake. */
  async connect(): Promise<MCPInitializeResult> {
    if (this._connected) throw new Error(`Already connected to ${this.serverName}`)

    const env = { ...process.env, ...this.config.env }

    this.proc = spawn(this.config.command, this.config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: this.config.cwd ?? process.cwd(),
      detached: false,
    })

    // Capture spawn errors immediately — ENOENT etc. fire on next tick
    const spawnError = new Promise<never>((_, reject) => {
      this.proc!.on('error', (err) => {
        this._connected = false
        this.rejectAll(err)
        reject(err)
      })
    })

    // Wire up data handlers
    this.proc.stdout!.on('data', (chunk: Buffer) => this.onData(chunk))
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      this.emit('stderr', chunk.toString())
    })
    this.proc.on('exit', (code) => {
      this._connected = false
      this.rejectAll(new Error(`MCP server "${this.serverName}" exited with code ${code}`))
      this.emit('exit', code)
    })

    // Wait for process to be ready, or fail fast on spawn error
    await Promise.race([
      new Promise((r) => setTimeout(r, 100)),
      spawnError,
    ])

    // If process died during startup, bail
    if (this.proc.exitCode !== null || this.proc.killed) {
      throw new Error(`MCP server "${this.serverName}" failed to start`)
    }

    // Send initialize request
    const result = (await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        roots: { listChanged: false },
      },
      clientInfo: {
        name: 'owlcoda',
        version: '0.7.0',
      },
    }, CONNECT_TIMEOUT_MS)) as MCPInitializeResult

    this._capabilities = result.capabilities
    this._serverInfo = result.serverInfo
    this._connected = true

    // Send initialized notification
    this.notify('notifications/initialized', {})

    return result
  }

  /** Disconnect the MCP server. */
  async disconnect(): Promise<void> {
    if (!this._connected || !this.proc) return

    this._connected = false
    this.rejectAll(new Error('Disconnecting'))

    // Try graceful exit
    try {
      this.proc.stdin!.end()
      this.proc.kill('SIGTERM')
    } catch {
      // Ignore — process may already be dead
    }

    // Wait briefly for clean exit
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { this.proc?.kill('SIGKILL') } catch { /* ignore */ }
        resolve()
      }, 2000)
      this.proc!.on('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })

    this.proc = null
  }

  // ─── MCP methods ────────────────────────────────────────────────

  async listTools(): Promise<MCPTool[]> {
    const res = (await this.request('tools/list', {})) as { tools: MCPTool[] }
    return res.tools ?? []
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<MCPToolCallResult> {
    return (await this.request('tools/call', { name, arguments: args })) as MCPToolCallResult
  }

  async listResources(): Promise<MCPResource[]> {
    const res = (await this.request('resources/list', {})) as { resources: MCPResource[] }
    return res.resources ?? []
  }

  async readResource(uri: string): Promise<MCPResourceContent[]> {
    const res = (await this.request('resources/read', { uri })) as { contents: MCPResourceContent[] }
    return res.contents ?? []
  }

  // ─── JSON-RPC transport ─────────────────────────────────────────

  private request(method: string, params: Record<string, unknown>, timeout = REQUEST_TIMEOUT_MS): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin?.writable) {
        return reject(new Error(`Cannot send request — server "${this.serverName}" not running`))
      }

      const id = this.nextId++
      const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }

      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request "${method}" timed out after ${timeout}ms`))
      }, timeout)

      this.pending.set(id, { resolve, reject, timer })

      const json = JSON.stringify(msg)
      this.proc.stdin.write(json + '\n')
    })
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.proc?.stdin?.writable) return
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params }
    this.proc.stdin.write(JSON.stringify(msg) + '\n')
  }

  private onData(chunk: Buffer): void {
    this.readBuffer += chunk.toString()

    // Process complete lines (newline-delimited JSON-RPC)
    let nlIdx: number
    while ((nlIdx = this.readBuffer.indexOf('\n')) !== -1) {
      const line = this.readBuffer.slice(0, nlIdx).trim()
      this.readBuffer = this.readBuffer.slice(nlIdx + 1)

      if (!line) continue

      try {
        const msg = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification

        // If it has an id, it's a response to one of our requests
        if ('id' in msg && msg.id !== undefined) {
          const pending = this.pending.get(msg.id as number)
          if (pending) {
            this.pending.delete(msg.id as number)
            clearTimeout(pending.timer)

            const resp = msg as JsonRpcResponse
            if (resp.error) {
              pending.reject(new Error(`MCP error ${resp.error.code}: ${resp.error.message}`))
            } else {
              pending.resolve(resp.result)
            }
          }
        } else if ('method' in msg) {
          // Server notification
          this.emit('notification', msg)
        }
      } catch {
        // Ignore malformed lines (e.g. debug output from server)
      }
    }
  }

  private rejectAll(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pending.clear()
  }
}
