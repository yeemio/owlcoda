import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { isPublicPath } from './manifest.js'
import { scanContent, type PublicTreeFile, type ScanViolation } from './scan.js'
import { transformPublicFile } from './transform.js'

const BINARY_EXT = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|eot|pdf|zip|gz|wasm|node)$/i

export interface BuildPublicMirrorOptions {
  sourceRoot: string
  outDir: string
  candidateFiles?: string[]
  clean?: boolean
}

export interface BuildPublicMirrorReport {
  included: string[]
  excluded: string[]
  scanned: number
  violations: ScanViolation[]
}

function normalize(path: string): string {
  return path.replace(/^\.\//, '').replace(/^\/+/, '')
}

export function listCandidateFiles(sourceRoot: string): string[] {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: sourceRoot,
    encoding: 'utf8',
  })
  return output.split('\n').map((line) => line.trim()).filter(Boolean)
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
}

export function buildPublicMirrorTree(options: BuildPublicMirrorOptions): BuildPublicMirrorReport {
  const sourceRoot = options.sourceRoot
  const outDir = options.outDir
  const candidates = (options.candidateFiles ?? listCandidateFiles(sourceRoot)).map(normalize)
  const included = candidates.filter(isPublicPath)
  const excluded = candidates.filter((path) => !isPublicPath(path))
  const clean = options.clean ?? true

  if (clean && existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const scannedFiles: PublicTreeFile[] = []

  for (const path of included) {
    const source = join(sourceRoot, path)
    const target = join(outDir, path)
    ensureParent(target)
    if (BINARY_EXT.test(path)) {
      copyFileSync(source, target)
      continue
    }
    const content = readFileSync(source, 'utf8')
    const transformed = transformPublicFile(path, content)
    writeFileSync(target, transformed)
    scannedFiles.push({ path, content: transformed })
  }

  return {
    included,
    excluded,
    scanned: scannedFiles.length,
    violations: scanContent(scannedFiles),
  }
}
