#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const sourceRoot = path.resolve(path.dirname(scriptPath), '..')
const options = parseArgs(process.argv.slice(2))
const projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : sourceRoot
const requestedCompileParent = path.resolve(options.compileDir ?? tmpdir())
const sourceRootRealpath = realpathSync(sourceRoot)
assertCompileParentOutsideSource(requestedCompileParent, sourceRootRealpath)
mkdirSync(requestedCompileParent, { recursive: true })
const compileParent = realpathSync(requestedCompileParent)
assertCompileParentOutsideSource(compileParent, sourceRootRealpath)
const previewRoot = mkdtempSync(path.join(compileParent, 'owlcoda-desktop-preview-package-'))
const compileDir = previewRootPath('dist')

let server
let evaluateDesktopCapabilityGate
try {
  compileAppServer()
  linkNodeModules()
  linkRunKitCore()

  const [httpServerModule, capabilityGateModule] = await Promise.all([
    import(`${pathToFileURL(path.join(compileDir, 'native', 'app-server', 'http-server.js')).href}?t=${Date.now()}`),
    import(`${pathToFileURL(path.join(compileDir, 'native', 'app-server', 'desktop-capability-gate.js')).href}?t=${Date.now()}`),
  ])
  evaluateDesktopCapabilityGate = capabilityGateModule.evaluateDesktopCapabilityGate
  server = httpServerModule.createAppServer({ projectRoot })
  await httpServerModule.listenAppServer(server, { host: options.host, port: options.port })
} catch (error) {
  cleanupCompileDir()
  throw error
}
const address = server.address()
const port = typeof address === 'object' && address ? address.port : options.port
const baseUrl = `http://${options.host}:${port}`
const desktopUrl = `${baseUrl}/desktop`

if (options.smoke) {
  try {
    const [healthResponse, desktopResponse, protocolResponse, runKitRailResponse] = await Promise.all([
      fetch(`${baseUrl}/healthz`),
      fetch(desktopUrl),
      rpc(baseUrl, 'protocol/describe', {}),
      rpc(baseUrl, 'runtimeRail/read', {}),
    ])
    const health = await healthResponse.json()
    const html = await desktopResponse.text()
    const protocolBody = await protocolResponse.json()
    const runKitRailBody = await runKitRailResponse.json()
    const protocol = protocolBody.result ?? null
    const runKitRail = runKitRailBody.result ?? null
    const capabilityGate = protocol ? evaluateDesktopCapabilityGate(protocol) : null
    console.log(JSON.stringify({
      ok: healthResponse.ok
        && desktopResponse.ok
        && protocolResponse.ok
        && runKitRailResponse.ok
        && Boolean(runKitRail)
        && runKitRail.freshness !== 'error',
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
      runKitRail: runKitRail ? {
        freshness: runKitRail.freshness,
        source: runKitRail.source,
        schemaVersion: runKitRail.summary?.schemaVersion ?? null,
        nextAllowedAction: runKitRail.summary?.nextAllowedAction ?? null,
        releaseAuthorization: runKitRail.summary?.releaseAuthorization ?? false,
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
      hasReadOnlyRunKitRail: html.includes('data-surface="runkit-context-summary"')
        && !html.includes('data-surface="runkit-truth-actions"')
        && !html.includes('proof/append')
        && !html.includes('gate/confirm'),
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
    projectRoot: undefined,
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
    } else if (arg === '--project-root') {
      parsed.projectRoot = requireValue(args, ++index, arg)
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

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function assertCompileParentOutsideSource(candidate, sourceRealpath) {
  if (isPathInside(sourceRealpath, candidate)) {
    throw new Error('--compile-dir must be outside the OwlCoda source tree')
  }

  let existingAncestor = candidate
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor)
    if (parent === existingAncestor) break
    existingAncestor = parent
  }
  const projectedCandidate = path.resolve(
    realpathSync(existingAncestor),
    path.relative(existingAncestor, candidate),
  )
  if (isPathInside(sourceRealpath, projectedCandidate)) {
    throw new Error('--compile-dir must be outside the OwlCoda source tree')
  }
}

function previewRootPath(...parts) {
  const target = path.resolve(previewRoot, ...parts)
  if (!isPathInside(previewRoot, target)) {
    throw new Error('Desktop preview path escaped its isolated package root')
  }
  return target
}

function compileAppServer() {
  rmSync(compileDir, { recursive: true, force: true })
  mkdirSync(compileDir, { recursive: true })
  const tsc = path.join(sourceRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')
  const result = spawnSync(tsc, [
    '--outDir',
    compileDir,
    '--declaration',
    'false',
    '--sourceMap',
    'false',
  ], {
    cwd: sourceRoot,
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
  const source = path.join(sourceRoot, 'node_modules')
  if (!existsSync(source)) {
    throw new Error('node_modules is missing; run npm ci first')
  }
  const target = previewRootPath('node_modules')
  rmSync(target, { recursive: true, force: true })
  symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
}

function linkRunKitCore() {
  const source = path.join(sourceRoot, 'scripts', 'runkit-contract')
  if (!existsSync(path.join(source, 'runkit-cli.mjs'))) {
    throw new Error('RunKit Core is missing from scripts/runkit-contract')
  }
  const scriptsRoot = previewRootPath('scripts')
  const target = previewRootPath('scripts', 'runkit-contract')
  mkdirSync(scriptsRoot, { recursive: true })
  rmSync(target, { recursive: true, force: true })
  symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
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
  rmSync(previewRoot, { recursive: true, force: true })
}

function printHelp() {
  console.log(`Usage: node scripts/start-owlcoda-desktop-preview.mjs [options]

Options:
  --host <host>           Host to bind. Default: 127.0.0.1
  --port <port>           Port to bind. Use 0 for any free port. Default: 6199
  --compile-dir <path>    Parent for an isolated preview package; the parent is preserved.
  --project-root <path>   Project whose .owlcoda/runkit truth is shown. Default: OwlCoda source root.
  --no-open               Do not open the desktop URL.
  --smoke                 Start, verify /healthz and /desktop, print JSON, then exit.
  -h, --help              Show this help.
`)
}
