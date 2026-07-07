#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(scriptPath), '..')
const options = parseArgs(process.argv.slice(2))
const ownsCompileDir = !options.compileDir
const compileDir = options.compileDir
  ? path.resolve(options.compileDir)
  : mkdtempSync(path.join(tmpdir(), 'owlcoda-desktop-preview-dist-'))

compileAppServer()
linkNodeModules()

const [
  { createAppServer, listenAppServer },
  { evaluateDesktopCapabilityGate },
] = await Promise.all([
  import(`${pathToFileURL(path.join(compileDir, 'native', 'app-server', 'http-server.js')).href}?t=${Date.now()}`),
  import(`${pathToFileURL(path.join(compileDir, 'native', 'app-server', 'desktop-capability-gate.js')).href}?t=${Date.now()}`),
])

const server = createAppServer({ projectRoot })
await listenAppServer(server, { host: options.host, port: options.port })
const address = server.address()
const port = typeof address === 'object' && address ? address.port : options.port
const baseUrl = `http://${options.host}:${port}`
const desktopUrl = `${baseUrl}/desktop`

if (options.smoke) {
  try {
    const [healthResponse, desktopResponse, protocolResponse] = await Promise.all([
      fetch(`${baseUrl}/healthz`),
      fetch(desktopUrl),
      rpc(baseUrl, 'protocol/describe', {}),
    ])
    const health = await healthResponse.json()
    const html = await desktopResponse.text()
    const protocolBody = await protocolResponse.json()
    const protocol = protocolBody.result ?? null
    const capabilityGate = protocol ? evaluateDesktopCapabilityGate(protocol) : null
    console.log(JSON.stringify({
      ok: healthResponse.ok && desktopResponse.ok && protocolResponse.ok,
      desktopUrl,
      health,
      protocol: protocol ? {
        schemaVersion: protocol.schemaVersion,
        protocolVersion: protocol.protocolVersion,
        methodCount: Array.isArray(protocol.methods) ? protocol.methods.length : 0,
        stableMethodCount: Array.isArray(protocol.methods)
          ? protocol.methods.filter((method) => method.stability === 'stable').length
          : 0,
        debugOnlyMethods: Array.isArray(protocol.methods)
          ? protocol.methods.filter((method) => method.stability === 'debug-only').map((method) => method.method)
          : [],
      } : null,
      capabilityGate: capabilityGate ? {
        ok: capabilityGate.ok,
        protocolVersion: capabilityGate.protocolVersion,
        requiredStableMissing: capabilityGate.requiredStableMethods
          .filter((method) => method.status !== 'available')
          .map((method) => method.method),
        optionalExperimentalAvailable: capabilityGate.optionalExperimentalMethods
          .filter((method) => method.status === 'available' && method.stability === 'experimental')
          .map((method) => method.method),
        debugOnlyMethods: capabilityGate.debugOnlyMethods,
        errors: capabilityGate.errors,
        warnings: capabilityGate.warnings,
      } : null,
      hasDesktopShell: html.includes('id="owlcoda-desktop-shell"'),
      hasProtocolContractSurface: html.includes('data-surface="app-server-protocol-contract"')
        && html.includes('protocol/describe'),
      hasRunKitRail: html.includes('data-surface="runkit-runtime-rail"'),
      hasLiveRuntimeEvents: html.includes('data-surface="live-runtime-events"'),
      hasLiveRuntimeItems: html.includes('data-surface="live-runtime-item"'),
      hasToolOutputDelta: html.includes('data-surface="tool-output-delta"'),
      hasApprovalSurface: html.includes('data-surface="approval-center"'),
      hasInteractionSurface: html.includes('data-surface="interaction-center"'),
      hasTruthWriterActions: html.includes('data-surface="runkit-truth-actions"'),
      hasProviderEvalReport: html.includes('data-surface="provider-eval-report"')
        && html.includes('benchmark/providerEvalReport/read'),
      hasRuntimeFactsSummary: html.includes('data-surface="runtime-facts-summary"')
        && html.includes('runtimeFacts/read'),
    }))
  } finally {
    await closeServer(server)
    cleanupCompileDir()
  }
  process.exit(0)
}

console.log(`OwlCoda Desktop preview: ${desktopUrl}`)
if (!options.noOpen) {
  openUrl(desktopUrl)
}

process.on('SIGINT', async () => {
  await closeServer(server)
  cleanupCompileDir()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await closeServer(server)
  cleanupCompileDir()
  process.exit(0)
})

await new Promise(() => {})

function parseArgs(args) {
  const parsed = {
    host: '127.0.0.1',
    port: 6199,
    noOpen: false,
    smoke: false,
    compileDir: undefined,
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--host') {
      parsed.host = requireValue(args, ++index, arg)
    } else if (arg === '--port') {
      parsed.port = Number(requireValue(args, ++index, arg))
      if (!Number.isInteger(parsed.port) || parsed.port < 0) {
        throw new Error('--port must be a non-negative integer')
      }
    } else if (arg === '--compile-dir') {
      parsed.compileDir = requireValue(args, ++index, arg)
    } else if (arg === '--no-open') {
      parsed.noOpen = true
    } else if (arg === '--smoke') {
      parsed.smoke = true
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return parsed
}

function requireValue(args, index, flag) {
  const value = args[index]
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

function compileAppServer() {
  rmSync(compileDir, { recursive: true, force: true })
  mkdirSync(compileDir, { recursive: true })
  const tsc = path.join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')
  const result = spawnSync(tsc, [
    '--outDir',
    compileDir,
    '--declaration',
    'false',
    '--sourceMap',
    'false',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: options.smoke ? 'pipe' : 'inherit',
  })
  if (result.status !== 0) {
    if (options.smoke) {
      process.stderr.write(result.stdout ?? '')
      process.stderr.write(result.stderr ?? '')
    }
    throw new Error(`TypeScript compile failed with exit code ${result.status}`)
  }
}

function linkNodeModules() {
  const source = path.join(projectRoot, 'node_modules')
  if (!existsSync(source)) {
    throw new Error('node_modules is missing; run npm ci first')
  }
  const target = path.join(compileDir, 'node_modules')
  rmSync(target, { recursive: true, force: true })
  symlinkSync(source, target, 'dir')
}

function openUrl(url) {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open'
  const args = process.platform === 'darwin'
    ? [url]
    : process.platform === 'win32'
      ? ['/c', 'start', '', url]
      : [url]
  const child = spawn(command, args, {
    stdio: 'ignore',
    detached: true,
  })
  child.unref()
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function rpc(url, method, params) {
  return fetch(`${url}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: method,
      method,
      params: params ?? {},
    }),
  })
}

function cleanupCompileDir() {
  if (!ownsCompileDir) return
  rmSync(compileDir, { recursive: true, force: true })
}

function printHelp() {
  console.log(`Usage: node scripts/start-owlcoda-desktop-preview.mjs [options]

Options:
  --host <host>           Host to bind. Default: 127.0.0.1
  --port <port>           Port to bind. Use 0 for any free port. Default: 6199
  --compile-dir <path>    Temporary compile output directory.
  --no-open               Do not open the desktop URL.
  --smoke                 Start, verify /healthz and /desktop, print JSON, then exit.
  -h, --help              Show this help.
`)
}
