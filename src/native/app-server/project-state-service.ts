import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function appServerProjectStatePath(projectRoot: string, fileName: string): string {
  const home = process.env['OWLCODA_HOME'] ?? join(homedir(), '.owlcoda')
  const projectId = createHash('sha256').update(realpathSync(projectRoot)).digest('hex').slice(0, 20)
  return join(home, 'app-server', 'projects', projectId, fileName)
}
