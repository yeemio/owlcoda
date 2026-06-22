import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface Args {
  tarball: string | null
  keepTemp: boolean
}

function parseArgs(): Args {
  const args = process.argv.slice(2)
  let tarball: string | null = null
  let keepTemp = false

  for (const arg of args) {
    if (arg.startsWith('--tarball=')) {
      tarball = arg.slice('--tarball='.length)
    } else if (arg === '--keep-temp') {
      keepTemp = true
    }
  }

  return { tarball, keepTemp }
}

function usage(): never {
  console.error('Usage: node --import tsx scripts/release-install-smoke.ts --tarball=/path/to/owlcoda.tgz [--keep-temp]')
  process.exit(2)
}

function readPackageVersion(): string {
  const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url))
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown }
  return String(packageJson.version ?? '')
}

function main(): void {
  const args = parseArgs()
  if (!args.tarball) {
    usage()
  }

  const installRoot = mkdtempSync(join(tmpdir(), 'owlcoda-release-install-smoke-'))
  try {
    execFileSync('npm', ['install', args.tarball, '--prefix', installRoot, '--no-audit', '--fund=false'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const binPath = join(installRoot, 'node_modules', '.bin', 'owlcoda')
    const versionResult = spawnSync(binPath, ['--version'], { encoding: 'utf8' })
    const versionOutput = `${versionResult.stdout ?? ''}${versionResult.stderr ?? ''}`
    if (versionResult.status !== 0) {
      console.error(`FAIL release install smoke: owlcoda --version exited ${versionResult.status}`)
      console.error(versionOutput.trim())
      process.exit(1)
    }
    const packageVersion = readPackageVersion()
    if (!versionOutput.includes(`owlcoda ${packageVersion}`)) {
      console.error(`FAIL release install smoke: expected owlcoda ${packageVersion}`)
      console.error(versionOutput.trim())
      process.exit(1)
    }
    console.log(`PASS release install smoke (${versionOutput.trim().split('\n')[0] ?? `owlcoda ${packageVersion}`})`)
  } finally {
    if (!args.keepTemp) {
      rmSync(installRoot, { recursive: true, force: true })
    }
  }
}

main()
