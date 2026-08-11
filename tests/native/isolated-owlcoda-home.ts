import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Keep session-backed tests away from the operator's persistent OwlCoda home. */
export function installIsolatedOwlCodaHome(prefix: string): () => void {
  const previousHome = process.env['OWLCODA_HOME']
  const testHome = mkdtempSync(join(tmpdir(), prefix))
  process.env['OWLCODA_HOME'] = testHome
  let restored = false

  return () => {
    if (restored) return
    restored = true
    if (previousHome === undefined) delete process.env['OWLCODA_HOME']
    else process.env['OWLCODA_HOME'] = previousHome
    rmSync(testHome, { recursive: true, force: true })
  }
}
