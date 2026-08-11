#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, win32 } from 'node:path'
import { isDirectExecution, isReservedRuntimePath } from './core-contract.mjs'

const SHA256_PATTERN = /^[a-f0-9]{64}$/i

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function compareUnicodeCodeUnits(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function canonicalSourceStream(files) {
  return Object.entries(files)
    .sort(([left], [right]) => compareUnicodeCodeUnits(left, right))
    .map(([path, hash]) => `${path}\tsha256:${hash.toLowerCase()}\n`)
    .join('')
}

export function canonicalSourceFingerprint(files) {
  return sha256(canonicalSourceStream(files))
}

function malformedResult(issues, extra = {}) {
  return {
    status: 'malformed_packet',
    exitCode: 3,
    issues,
    ...extra,
  }
}

function safePacketPath(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || win32.parse(path).root) return false
  if (path.includes('\\') || path.includes('\0')) return false
  const segments = path.split('/')
  return !segments.includes('..') && !segments.includes('.') && segments.every(Boolean) && !isReservedRuntimePath(path)
}

function withinRoot(root, candidate) {
  const remainder = relative(root, candidate)
  return remainder === '' || (!remainder.startsWith('../') && remainder !== '..' && !isAbsolute(remainder))
}

function validOwnedRule(value) {
  if (typeof value !== 'string' || !value) return false
  if (!value.endsWith('/**')) return safePacketPath(value)
  const prefix = value.slice(0, -3)
  return safePacketPath(prefix)
}

function matchesOwnedRule(filePath, rule) {
  if (rule.endsWith('/**')) {
    const prefix = rule.slice(0, -3)
    return filePath === prefix || filePath.startsWith(`${prefix}/`)
  }
  return filePath === rule
}

function ownedStatusRecords(workspaceRoot, ownedPaths) {
  const completed = spawnSync('git', [
    '-C', workspaceRoot,
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    '.',
    ':(exclude).owlcoda/runkit/**',
  ], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (completed.error) throw completed.error
  if (completed.status !== 0) throw new Error(completed.stderr.trim() || 'Git status failed')
  const entries = completed.stdout.split('\0')
  const records = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry) continue
    if (entry.length < 4 || entry[2] !== ' ') throw new Error('Git status emitted a malformed entry')
    const status = entry.slice(0, 2)
    const currentPath = entry.slice(3)
    const paths = [currentPath]
    if (status.includes('R') || status.includes('C')) {
      const priorPath = entries[index + 1]
      if (!priorPath) throw new Error('Git status rename entry is incomplete')
      paths.push(priorPath)
      index += 1
    }
    if (!paths.some(filePath => ownedPaths.some(rule => matchesOwnedRule(filePath, rule)))) continue
    records.push({ status, paths })
  }
  return records.sort((left, right) =>
    JSON.stringify(left.paths).localeCompare(JSON.stringify(right.paths)))
}

function boundLease({ root, packet }) {
  if (typeof packet.discovery?.leasePath !== 'string'
    || typeof packet.discovery?.fromLease !== 'string') {
    return null
  }
  const leaseCandidate = resolve(root, packet.discovery.leasePath)
  if (!withinRoot(root, leaseCandidate)) {
    return { malformed: 'ownedPathState leasePath escapes workspace' }
  }
  try {
    const stat = lstatSync(leaseCandidate)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { malformed: 'ownedPathState leasePath must be a regular file' }
    }
    const realLease = realpathSync(leaseCandidate)
    if (!withinRoot(root, realLease)) {
      return { malformed: 'ownedPathState leasePath resolves outside workspace' }
    }
    const lease = JSON.parse(readFileSync(realLease, 'utf8'))
    if (lease.workItemId !== packet.discovery.fromLease
      || !Array.isArray(lease.ownedPaths)
      || lease.ownedPaths.length === 0
      || new Set(lease.ownedPaths).size !== lease.ownedPaths.length
      || lease.ownedPaths.some(rule => !validOwnedRule(rule))) {
      return { malformed: 'ownedPathState lease artifact is invalid' }
    }
    return { lease }
  } catch {
    return { malformed: 'ownedPathState lease artifact is unreadable' }
  }
}

function validateOwnedPathState({ root, packet, declaredFiles }) {
  const state = packet?.discovery?.ownedPathState
  const leaseBinding = boundLease({ root, packet })
  if (state === undefined) {
    if (leaseBinding === null) return { issues: [] }
    if (leaseBinding.malformed) return { malformed: [leaseBinding.malformed] }
    let current
    try {
      current = ownedStatusRecords(root, leaseBinding.lease.ownedPaths)
    } catch {
      return { malformed: ['legacy DeliveryPacket requires readable Git status'] }
    }
    const declaredPaths = Object.keys(declaredFiles).sort()
    const currentPaths = current.map(record => record.paths[0]).sort()
    return JSON.stringify(currentPaths) === JSON.stringify(declaredPaths)
      ? { issues: [] }
      : { issues: ['owned workspace status paths changed since legacy DeliveryPacket creation'] }
  }
  if (!isRecord(state)
    || state.schemaVersion !== 'OwlCodaRunKitOwnedPathStateV1'
    || state.statusMode !== 'porcelain-v1-z-untracked-all-runkit-excluded'
    || !Array.isArray(state.ownedPaths)
    || state.ownedPaths.length === 0
    || !Array.isArray(state.records)) {
    return { malformed: ['ownedPathState is malformed'] }
  }
  if (state.ownedPaths.some(rule => !validOwnedRule(rule))
    || new Set(state.ownedPaths).size !== state.ownedPaths.length) {
    return { malformed: ['ownedPathState ownedPaths are invalid'] }
  }
  for (const record of state.records) {
    if (!isRecord(record)
      || typeof record.status !== 'string'
      || record.status.length !== 2
      || !Array.isArray(record.paths)
      || record.paths.length === 0
      || record.paths.some(filePath => !safePacketPath(filePath))
      || !record.paths.some(filePath =>
        state.ownedPaths.some(rule => matchesOwnedRule(filePath, rule)))) {
      return { malformed: ['ownedPathState records are invalid'] }
    }
  }
  if (leaseBinding === null) {
    return { malformed: ['ownedPathState requires leasePath and fromLease'] }
  }
  if (leaseBinding.malformed) return { malformed: [leaseBinding.malformed] }
  if (JSON.stringify(leaseBinding.lease.ownedPaths) !== JSON.stringify(state.ownedPaths)) {
    return { malformed: ['ownedPathState does not match its lease artifact'] }
  }
  const declaredPaths = Object.keys(declaredFiles).sort()
  const recordedCurrentPaths = state.records
    .map(record => record.paths[0])
    .sort()
  if (JSON.stringify(recordedCurrentPaths) !== JSON.stringify(declaredPaths)) {
    return { malformed: ['ownedPathState records do not match declared changed files'] }
  }
  let current
  try {
    current = ownedStatusRecords(root, state.ownedPaths)
  } catch {
    return { malformed: ['ownedPathState requires readable Git status'] }
  }
  return JSON.stringify(current) === JSON.stringify(state.records)
    ? { issues: [] }
    : { issues: ['owned workspace status changed since DeliveryPacket creation'] }
}

function extractDeclaredFiles(packet) {
  if (!isRecord(packet) || !isRecord(packet.changedFiles)) {
    return { issues: ['changedFiles must be an object'] }
  }
  const shapes = []
  for (const key of ['files', 'wholeFileSha256']) {
    if (!(key in packet.changedFiles)) continue
    const value = packet.changedFiles[key]
    if (!isRecord(value)) return { issues: [`changedFiles.${key} must be an object`] }
    shapes.push([key, value])
  }
  if (shapes.length === 0) {
    return { issues: ['changedFiles.files or changedFiles.wholeFileSha256 is required'] }
  }
  if (shapes.length > 1) {
    return { issues: ['packet must declare exactly one changed file hash shape'] }
  }

  const files = {}
  const issues = []
  const [shape, entries] = shapes[0]
  for (const [path, hash] of Object.entries(entries)) {
    if (!safePacketPath(path)) {
      issues.push(isReservedRuntimePath(path) ? `reserved runtime path: ${path}` : `unsafe scoped path: ${path}`)
    }
    if (typeof hash !== 'string' || !SHA256_PATTERN.test(hash)) {
      issues.push(`invalid SHA-256 for ${path} in changedFiles.${shape}`)
      continue
    }
    files[path] = hash.toLowerCase()
  }
  if (Object.keys(files).length === 0) issues.push('at least one scoped path is required')
  return issues.length > 0 ? { issues } : { files }
}

function inspectWorkspaceFile(root, path) {
  let current = root
  const segments = path.split('/')
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index])
    let stat
    try {
      stat = lstatSync(current)
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return { status: 'missing' }
      return { status: 'unreadable' }
    }
    if (stat.isSymbolicLink()) return { status: 'malformed', issue: `scoped path traverses a symlink: ${path}` }
    const isLeaf = index === segments.length - 1
    if (!isLeaf && !stat.isDirectory()) {
      return { status: 'malformed', issue: `scoped path has a non-directory parent: ${path}` }
    }
    if (isLeaf && !stat.isFile()) {
      return { status: 'malformed', issue: `scoped path is not a regular file: ${path}` }
    }
  }
  return { status: 'regular_file', path: current }
}

function extractDeclaredFingerprint(packet) {
  const declarations = []
  for (const key of ['productSourceFingerprint', 'sourceFingerprint']) {
    if (!(key in packet)) continue
    if (!isRecord(packet[key]) || typeof packet[key].sha256 !== 'string') {
      return { issues: [`${key}.sha256 must be a string`] }
    }
    declarations.push([key, packet[key].sha256])
  }
  if (declarations.length === 0) {
    return { issues: ['productSourceFingerprint.sha256 or sourceFingerprint.sha256 is required'] }
  }
  if (declarations.length > 1) {
    return { issues: ['packet must declare exactly one source fingerprint shape'] }
  }
  const [shape, fingerprint] = declarations[0]
  if (!SHA256_PATTERN.test(fingerprint)) {
    return { issues: [`${shape}.sha256 must be a 64-character SHA-256`] }
  }
  return { fingerprint: fingerprint.toLowerCase(), shape }
}

export function verifyDeliveryPacket({ workspaceRoot, packet }) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot) {
    return malformedResult(['workspaceRoot is required'])
  }

  let root
  try {
    root = realpathSync(workspaceRoot)
  } catch {
    return malformedResult(['workspaceRoot does not exist'])
  }

  const declaredFiles = extractDeclaredFiles(packet)
  if (declaredFiles.issues) return malformedResult(declaredFiles.issues)
  const declaredFingerprint = extractDeclaredFingerprint(packet)
  if (declaredFingerprint.issues) return malformedResult(declaredFingerprint.issues)
  const ownedPathState = validateOwnedPathState({
    root,
    packet,
    declaredFiles: declaredFiles.files,
  })
  if (ownedPathState.malformed) return malformedResult(ownedPathState.malformed)

  const issues = [...ownedPathState.issues]
  const actualFiles = {}
  const declaredCanonicalStream = canonicalSourceStream(declaredFiles.files)
  const fingerprintFromDeclaredHashes = sha256(declaredCanonicalStream)
  if (fingerprintFromDeclaredHashes !== declaredFingerprint.fingerprint) {
    issues.push('declared fingerprint does not match the canonical declared file hashes')
  }

  for (const [path, expectedHash] of Object.entries(declaredFiles.files).sort(([left], [right]) => compareUnicodeCodeUnits(left, right))) {
    const candidate = resolve(root, path)
    if (!withinRoot(root, candidate)) {
      return malformedResult([`scoped path escapes workspace: ${path}`])
    }
    const inspected = inspectWorkspaceFile(root, path)
    if (inspected.status === 'malformed') return malformedResult([inspected.issue])
    if (inspected.status === 'missing') {
      issues.push(`missing scoped file: ${path}`)
      continue
    }
    if (inspected.status === 'unreadable') {
      issues.push(`unreadable scoped file: ${path}`)
      continue
    }
    let realCandidate
    try {
      realCandidate = realpathSync(inspected.path)
    } catch {
      issues.push(`unreadable scoped file: ${path}`)
      continue
    }
    if (!withinRoot(root, realCandidate)) {
      return malformedResult([`scoped path resolves outside workspace: ${path}`])
    }
    try {
      const actualHash = sha256(readFileSync(realCandidate))
      actualFiles[path] = actualHash
      if (actualHash !== expectedHash) issues.push(`whole-file hash mismatch: ${path}`)
    } catch {
      issues.push(`unreadable scoped file: ${path}`)
    }
  }

  const hasAllActualFiles = Object.keys(actualFiles).length === Object.keys(declaredFiles.files).length
  const actualCanonicalStream = hasAllActualFiles ? canonicalSourceStream(actualFiles) : null
  const recomputedFingerprint = actualCanonicalStream ? sha256(actualCanonicalStream) : null
  if (recomputedFingerprint && recomputedFingerprint !== declaredFingerprint.fingerprint) {
    issues.push('recomputed workspace fingerprint does not match the packet declaration')
  }

  const status = issues.length === 0 ? 'valid' : 'invalidated_by_concurrent_write'
  return {
    status,
    exitCode: status === 'valid' ? 0 : 2,
    fileCount: Object.keys(declaredFiles.files).length,
    fingerprintShape: declaredFingerprint.shape,
    declaredFingerprint: declaredFingerprint.fingerprint,
    fingerprintFromDeclaredHashes,
    recomputedFingerprint,
    canonicalStream: actualCanonicalStream ?? declaredCanonicalStream,
    issues,
  }
}

function parseCliArguments(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if ((flag !== '--workspace' && flag !== '--packet') || !value) return null
    if (flag === '--workspace') result.workspaceRoot = value
    if (flag === '--packet') result.packetPath = value
  }
  return result.workspaceRoot && result.packetPath ? result : null
}

function runCli(argv) {
  const input = parseCliArguments(argv)
  if (!input) return malformedResult(['usage: source-fingerprint.mjs --workspace <root> --packet <packet.json>'])
  let packet
  try {
    packet = JSON.parse(readFileSync(input.packetPath, 'utf8'))
  } catch {
    return malformedResult(['packet must exist and contain valid JSON'])
  }
  return verifyDeliveryPacket({ workspaceRoot: input.workspaceRoot, packet })
}

if (isDirectExecution(import.meta.url)) {
  const result = runCli(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = result.exitCode
}
