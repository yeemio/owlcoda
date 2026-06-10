/**
 * Regression: the platform catalog's `intent_defaults` must be wired onto the
 * loaded config so intent routing can honor them.
 *
 * Bug (pre-fix): loadConfig() built models from the catalog and set
 * catalogLoaded=true, but never carried catalog.intent_defaults onto the
 * config object. resolveIntentModel() reads config._intentDefaults, which was
 * therefore always undefined → the catalog branch was dead and every intent
 * silently fell through to the hard-coded INTENT_TIER_MAP.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../src/config.js'
import { resolveIntentModel } from '../src/intent-router.js'

const CATALOG_ENV = 'OWLCODA_CATALOG_PATH'
const tmpDirs: string[] = []
let prevCatalogEnv: string | undefined

afterEach(() => {
  if (prevCatalogEnv === undefined) delete process.env[CATALOG_ENV]
  else process.env[CATALOG_ENV] = prevCatalogEnv
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

/**
 * Write a platform catalog (with intent_defaults) + an empty user config.
 * Empty user config forces loadConfig down the catalog branch
 * (merged.models.length === 0). Returns the config path to load.
 */
function setupCatalogConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'owlcoda-intent-catalog-'))
  tmpDirs.push(dir)

  const catalogPath = join(dir, 'catalog.json')
  writeFileSync(catalogPath, JSON.stringify({
    version: 2,
    default_model: 'general-model',
    intent_defaults: { code: 'coder-model', analysis: 'thinker-model' },
    models: [
      { id: 'general-model', channel: 'stable', priority_role: 'default_chat_primary' },
      { id: 'coder-model', channel: 'preview', priority_role: 'code_editing' },
      { id: 'thinker-model', channel: 'preview', priority_role: 'heavy_reasoning' },
    ],
    aliases: {},
  }))
  prevCatalogEnv = process.env[CATALOG_ENV]
  process.env[CATALOG_ENV] = catalogPath

  const configPath = join(dir, 'config.json')
  writeFileSync(configPath, JSON.stringify({})) // no user models → catalog branch
  return configPath
}

describe('catalog intent_defaults wiring', () => {
  it('carries catalog.intent_defaults onto the loaded config', () => {
    const config = loadConfig(setupCatalogConfig())
    expect(config.catalogLoaded).toBe(true)
    expect(config._intentDefaults).toEqual({ code: 'coder-model', analysis: 'thinker-model' })
  })

  it('resolveIntentModel honors a catalog intent default over the tier map', () => {
    const config = loadConfig(setupCatalogConfig())
    // Catalog maps code → coder-model. Pre-fix, the catalog branch was dead, so
    // the tier map resolved 'code' to the first production-tier model
    // (general-model, channel "stable"), not the catalog's choice.
    expect(resolveIntentModel(config, 'code')).toBe('coder-model')
  })
})
