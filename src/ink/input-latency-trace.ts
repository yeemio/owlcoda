import { openSync, writeSync } from 'fs'

const configuredPath = process.env.OWLCODA_TRACE_INPUT_LATENCY?.trim()
const tracePath = configuredPath && configuredPath !== '0' && configuredPath.toLowerCase() !== 'false'
  ? configuredPath === '1'
    ? `/tmp/owlcoda-input-latency-${process.pid}.jsonl`
    : configuredPath
  : ''

type PendingInput = {
  seq: number
  hrNs: bigint
  bytes: number
  chars: number
}

type ParsedInputTrace = {
  kind?: string
  sequence?: string
  name?: string
  ctrl?: boolean
  meta?: boolean
  option?: boolean
  shift?: boolean
  super?: boolean
}

type InputEventTrace = {
  input: string
  key: {
    ctrl: boolean
    meta: boolean
    shift: boolean
    return: boolean
    backspace: boolean
    delete: boolean
    tab: boolean
    escape: boolean
  }
}

let fd: number | null = null
let inputSeq = 0
let writeSeq = 0
const pendingInputs: PendingInput[] = []

function getTraceFd(): number | null {
  if (!tracePath) return null
  if (fd !== null) return fd
  try {
    fd = openSync(tracePath, 'a')
    writeJson({
      type: 'input-latency-trace-open',
      pid: process.pid,
      ts: new Date().toISOString(),
    })
    return fd
  } catch {
    fd = null
    return null
  }
}

function nowNs(): bigint {
  return process.hrtime.bigint()
}

function elapsedMs(fromNs: bigint, toNs = nowNs()): number {
  return Number(toNs - fromNs) / 1_000_000
}

function preview(input: string, limit = 80): string {
  return input.length > limit ? `${input.slice(0, limit)}...` : input
}

function codepoints(input: string, limit = 24): string[] {
  const values: string[] = []
  for (const char of input) {
    values.push(`0x${char.codePointAt(0)!.toString(16).padStart(2, '0')}`)
    if (values.length >= limit) break
  }
  return values
}

function writeJson(data: Record<string, unknown>): void {
  const out = getTraceFd()
  if (out === null) return
  try {
    writeSync(out, `${JSON.stringify({ tsMs: Date.now(), ...data })}\n`)
  } catch {
    // Diagnostic-only tracing must never affect interactive input.
  }
}

export function isInputLatencyTraceEnabled(): boolean {
  return Boolean(tracePath)
}

export function traceInputLatencyStdinChunk(chunk: string | Buffer): number | null {
  if (!isInputLatencyTraceEnabled()) return null
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  const seq = ++inputSeq
  const item: PendingInput = {
    seq,
    hrNs: nowNs(),
    bytes: Buffer.byteLength(text, 'utf8'),
    chars: text.length,
  }
  pendingInputs.push(item)
  if (pendingInputs.length > 512) pendingInputs.splice(0, pendingInputs.length - 512)
  writeJson({
    type: 'stdin-chunk',
    seq,
    bytes: item.bytes,
    chars: item.chars,
    preview: preview(text),
    codepoints: codepoints(text),
  })
  return seq
}

export function traceInputLatencyParsedKeys(inputSeqForChunk: number | null, keys: ParsedInputTrace[]): void {
  if (!isInputLatencyTraceEnabled()) return
  writeJson({
    type: 'parsed-keys',
    inputSeq: inputSeqForChunk,
    count: keys.length,
    keys: keys.map(key => ({
      kind: key.kind,
      sequence: key.sequence ? preview(key.sequence, 40) : undefined,
      sequenceCodepoints: key.sequence ? codepoints(key.sequence, 16) : undefined,
      name: key.name,
      ctrl: key.ctrl,
      meta: key.meta,
      option: key.option,
      shift: key.shift,
      super: key.super,
    })),
  })
}

export function traceInputLatencyInputEvent(event: InputEventTrace): void {
  if (!isInputLatencyTraceEnabled()) return
  writeJson({
    type: 'input-event',
    input: preview(event.input, 40),
    inputCodepoints: codepoints(event.input, 16),
    key: event.key,
  })
}

export function traceInputLatencyCheckpoint(type: string, data: Record<string, unknown> = {}): void {
  if (!isInputLatencyTraceEnabled()) return
  const at = nowNs()
  const oldest = pendingInputs[0]
  const newest = pendingInputs[pendingInputs.length - 1]
  writeJson({
    type,
    pendingInputCount: pendingInputs.length,
    oldestInputSeq: oldest?.seq ?? null,
    newestInputSeq: newest?.seq ?? null,
    oldestInputAgeMs: oldest ? Number(elapsedMs(oldest.hrNs, at).toFixed(3)) : null,
    newestInputAgeMs: newest ? Number(elapsedMs(newest.hrNs, at).toFixed(3)) : null,
    ...data,
  })
}

export function traceInputLatencyWriteComplete(meta: {
  bytes: number
  patches: number
  optimizedPatches: number
  frameDurationMs: number
  writeCallbackMs: number
  altScreen: boolean
  targetMoved: boolean
  yogaVisited: number
  yogaMeasured: number
}): void {
  if (!isInputLatencyTraceEnabled()) return
  const completedAt = nowNs()
  const inputs = pendingInputs.splice(0, pendingInputs.length)
  const oldest = inputs[0]
  const newest = inputs[inputs.length - 1]
  writeJson({
    type: 'write-complete',
    seq: ++writeSeq,
    inputCount: inputs.length,
    oldestInputSeq: oldest?.seq ?? null,
    newestInputSeq: newest?.seq ?? null,
    oldestInputToWriteMs: oldest ? Number(elapsedMs(oldest.hrNs, completedAt).toFixed(3)) : null,
    newestInputToWriteMs: newest ? Number(elapsedMs(newest.hrNs, completedAt).toFixed(3)) : null,
    inputBytes: inputs.reduce((sum, item) => sum + item.bytes, 0),
    inputChars: inputs.reduce((sum, item) => sum + item.chars, 0),
    writeBytes: meta.bytes,
    patches: meta.patches,
    optimizedPatches: meta.optimizedPatches,
    frameDurationMs: Number(meta.frameDurationMs.toFixed(3)),
    writeCallbackMs: Number(meta.writeCallbackMs.toFixed(3)),
    altScreen: meta.altScreen,
    targetMoved: meta.targetMoved,
    yogaVisited: meta.yogaVisited,
    yogaMeasured: meta.yogaMeasured,
  })
}
