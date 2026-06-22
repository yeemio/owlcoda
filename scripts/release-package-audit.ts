import { execFileSync } from 'node:child_process'

import { auditReleasePackageFileList } from '../src/native/release-package-audit.js'

interface Args {
  tarball: string | null
  json: boolean
}

function parseArgs(): Args {
  const args = process.argv.slice(2)
  let tarball: string | null = null
  let json = false

  for (const arg of args) {
    if (arg.startsWith('--tarball=')) {
      tarball = arg.slice('--tarball='.length)
    } else if (arg === '--json') {
      json = true
    }
  }

  return { tarball, json }
}

function usage(): never {
  console.error('Usage: node --import tsx scripts/release-package-audit.ts --tarball=/path/to/owlcoda.tgz [--json]')
  process.exit(2)
}

function readTarballFileList(tarball: string): string[] {
  return execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.trim().length > 0)
}

const args = parseArgs()
if (!args.tarball) {
  usage()
}

const audit = auditReleasePackageFileList(readTarballFileList(args.tarball))

if (args.json) {
  console.log(JSON.stringify(audit, null, 2))
} else if (audit.passed) {
  console.log(`PASS release package audit (entries=${audit.entryCount} skillEntrypoints=${audit.hasSkillEntrypoints})`)
} else {
  console.error(`FAIL release package audit (missing=${audit.missing.length} forbidden=${audit.forbidden.length})`)
  if (audit.missing.length > 0) {
    console.error(`missing: ${audit.missing.join(', ')}`)
  }
  if (audit.forbidden.length > 0) {
    console.error(`forbidden: ${audit.forbidden.slice(0, 20).join(', ')}`)
  }
}

process.exit(audit.passed ? 0 : 1)
