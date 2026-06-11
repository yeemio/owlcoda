import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
}

describe('declared runtime dependencies (no phantom deps on the public entry chain)', () => {
  // src/native/tui/colors.ts and text.ts — reachable from the server default
  // export AND the `owlcoda/headless` public entry — do `import stringWidth from
  // 'string-width'`. It must be a DIRECT dependency, not borrowed transitively
  // from wrap-ansi: strict installers (pnpm, Yarn PnP) won't resolve a phantom
  // dep, so the public entry would throw ERR_MODULE_NOT_FOUND on import.
  it('declares string-width directly', () => {
    expect(pkg.dependencies?.['string-width']).toBeDefined()
  })
})
