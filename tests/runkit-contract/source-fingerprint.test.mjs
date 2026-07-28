import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  canonicalSourceFingerprint,
  verifyDeliveryPacket,
} from '../../scripts/runkit-contract/source-fingerprint.mjs'

const cliPath = fileURLToPath(new URL('../../scripts/runkit-contract/source-fingerprint.mjs', import.meta.url))

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'owlcoda-source-gate-'))
  writeFileSync(join(root, 'a.txt'), 'alpha\n')
  writeFileSync(join(root, 'b.txt'), 'beta\n')
  return root
}

function sourceHashes(root) {
  return {
    'b.txt': sha256(readFileSync(join(root, 'b.txt'))),
    'a.txt': sha256(readFileSync(join(root, 'a.txt'))),
  }
}

function filesShapePacket(root) {
  const files = sourceHashes(root)
  return {
    schemaVersion: 'ExecutionDeliveryPacketV1',
    changedFiles: { files },
    productSourceFingerprint: { sha256: canonicalSourceFingerprint(files) },
  }
}

function wholeFileShapePacket(root) {
  const wholeFileSha256 = sourceHashes(root)
  return {
    schemaVersion: 'ExecutionDeliveryPacketV1',
    changedFiles: { wholeFileSha256 },
    sourceFingerprint: { sha256: canonicalSourceFingerprint(wholeFileSha256) },
  }
}

test('accepts both delivery packet hash shapes and canonicalizes paths lexically', () => {
  const root = makeWorkspace()
  try {
    for (const packet of [filesShapePacket(root), wholeFileShapePacket(root)]) {
      const result = verifyDeliveryPacket({ workspaceRoot: root, packet })
      assert.equal(result.status, 'valid')
      assert.equal(result.exitCode, 0)
      assert.equal(result.fileCount, 2)
      assert.equal(result.canonicalStream, [
        `a.txt\tsha256:${sha256('alpha\n')}\n`,
        `b.txt\tsha256:${sha256('beta\n')}\n`,
      ].join(''))
      assert.equal(result.recomputedFingerprint, packet.productSourceFingerprint?.sha256 ?? packet.sourceFingerprint.sha256)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('classifies missing, changed, and fingerprint-mismatched evidence as stale', () => {
  const root = makeWorkspace()
  try {
    const changed = filesShapePacket(root)
    writeFileSync(join(root, 'a.txt'), 'changed\n')
    assert.deepEqual(
      verifyDeliveryPacket({ workspaceRoot: root, packet: changed }).status,
      'invalidated_by_concurrent_write',
    )

    const missing = filesShapePacket(root)
    delete missing.changedFiles.files['b.txt']
    missing.changedFiles.files['missing.txt'] = sha256('missing\n')
    missing.productSourceFingerprint.sha256 = canonicalSourceFingerprint(missing.changedFiles.files)
    assert.equal(verifyDeliveryPacket({ workspaceRoot: root, packet: missing }).exitCode, 2)

    const wrongFingerprint = wholeFileShapePacket(root)
    wrongFingerprint.sourceFingerprint.sha256 = '0'.repeat(64)
    const result = verifyDeliveryPacket({ workspaceRoot: root, packet: wrongFingerprint })
    assert.equal(result.status, 'invalidated_by_concurrent_write')
    assert.match(result.issues.join('\n'), /fingerprint/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects absolute, escaping, duplicate, and malformed packet paths', () => {
  const root = makeWorkspace()
  try {
    const hash = sha256('alpha\n')
    const cases = [
      {
        changedFiles: { files: { '/tmp/absolute.txt': hash } },
        productSourceFingerprint: { sha256: '0'.repeat(64) },
      },
      {
        changedFiles: { files: { '../escape.txt': hash } },
        productSourceFingerprint: { sha256: '0'.repeat(64) },
      },
      {
        changedFiles: { files: { 'a.txt': hash }, wholeFileSha256: { 'a.txt': hash } },
        productSourceFingerprint: { sha256: canonicalSourceFingerprint({ 'a.txt': hash }) },
      },
      {
        changedFiles: { files: { 'a.txt': 'not-a-sha' } },
        productSourceFingerprint: { sha256: '0'.repeat(64) },
      },
    ]
    for (const packet of cases) {
      const result = verifyDeliveryPacket({ workspaceRoot: root, packet })
      assert.equal(result.status, 'malformed_packet')
      assert.equal(result.exitCode, 3)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI returns 0 for valid, 2 for stale, 3 for malformed, and never writes the workspace', () => {
  const root = makeWorkspace()
  try {
    const packetPath = join(root, 'packet.json')
    const run = packet => {
      writeFileSync(packetPath, JSON.stringify(packet))
      const before = {
        a: sha256(readFileSync(join(root, 'a.txt'))),
        b: sha256(readFileSync(join(root, 'b.txt'))),
        entries: readdirSync(root).sort(),
      }
      const result = spawnSync(process.execPath, [cliPath, '--workspace', root, '--packet', packetPath], { encoding: 'utf8' })
      const after = {
        a: sha256(readFileSync(join(root, 'a.txt'))),
        b: sha256(readFileSync(join(root, 'b.txt'))),
        entries: readdirSync(root).sort(),
      }
      assert.deepEqual(after, before)
      return { ...result, output: JSON.parse(result.stdout) }
    }

    const validPacket = filesShapePacket(root)
    const valid = run(validPacket)
    assert.equal(valid.status, 0)
    assert.equal(valid.output.status, 'valid')

    writeFileSync(join(root, 'a.txt'), 'stale\n')
    const stale = run(validPacket)
    assert.equal(stale.status, 2)
    assert.equal(stale.output.status, 'invalidated_by_concurrent_write')

    const malformed = run({
      changedFiles: { wholeFileSha256: { '../outside.txt': sha256('outside') } },
      sourceFingerprint: { sha256: '0'.repeat(64) },
    })
    assert.equal(malformed.status, 3)
    assert.equal(malformed.output.status, 'malformed_packet')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
