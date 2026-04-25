import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadCatalog, buildModelSurfaceSync, resolveModelName, getRouterModelName } from '../src/models/catalog.js'
import type { ModelSurface } from '../src/models/catalog.js'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ─── Minimal catalog fixture ───

function makeCatalog() {
  return {
    version: 2,
    default_model: 'Model-A-Primary',
    intent_defaults: {
      general_chat: 'Model-A-Primary',
      heavy_reasoning: 'Model-B-Heavy',
    },
    models: [
      {
        id: 'Model-A-Primary',
        channel: 'stable',
        backend: 'omlx',
        priority_role: 'default_chat_primary',
        tool_calling_support: 'native',
      },
      {
        id: 'Model-B-Heavy',
        channel: 'stable',
        backend: 'vllm',
        priority_role: 'heavy_reasoning',
        tool_calling_support: 'native',
      },
      {
        id: 'Model-C-Fast',
        channel: 'preview',
        backend: 'omlx',
        priority_role: 'fast_iteration',
      },
    ],
    aliases: {
      default: { target: 'Model-A-Primary' },
      heavy: { target: 'Model-B-Heavy' },
      fast: { target: 'Model-C-Fast' },
    },
    work_types: {
      code_editing: { primary_model: 'Model-A-Primary' },
    },
  }
}

let tmpDir: string

beforeEach(() => {
  tmpDir = join(tmpdir(), `owlcoda-catalog-test-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })
})

afterEach(() => {
  delete process.env['OWLCODA_CATALOG_PATH']
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

describe('catalog loading', () => {
  it('loads catalog from OWLCODA_CATALOG_PATH', () => {
    const catalogPath = join(tmpDir, 'catalog.json')
    writeFileSync(catalogPath, JSON.stringify(makeCatalog()))
    process.env['OWLCODA_CATALOG_PATH'] = catalogPath
    const catalog = loadCatalog()
    expect(catalog).not.toBeNull()
    expect(catalog!.version).toBe(2)
    expect(catalog!.default_model).toBe('Model-A-Primary')
    expect(catalog!.models).toHaveLength(3)
  })

  it('returns null when OWLCODA_CATALOG_PATH is set but file missing', () => {
    process.env['OWLCODA_CATALOG_PATH'] = join(tmpDir, 'nonexistent.json')
    const catalog = loadCatalog()
    expect(catalog).toBeNull()
  })

  it('returns null when OWLCODA_CATALOG_PATH points to invalid JSON', () => {
    const bad = join(tmpDir, 'bad.json')
    writeFileSync(bad, 'not json{{{')
    process.env['OWLCODA_CATALOG_PATH'] = bad
    const catalog = loadCatalog()
    expect(catalog).toBeNull()
  })

  it('does NOT fall through to search paths when OWLCODA_CATALOG_PATH is set', () => {
    // Critical test: env var set to nonexistent = no catalog, period
    process.env['OWLCODA_CATALOG_PATH'] = '/definitely/not/real/catalog.json'
    const catalog = loadCatalog()
    expect(catalog).toBeNull()
  })
})

describe('buildModelSurfaceSync', () => {
  it('builds surface from catalog with correct model count', () => {
    const catalogPath = join(tmpDir, 'catalog.json')
    writeFileSync(catalogPath, JSON.stringify(makeCatalog()))
    process.env['OWLCODA_CATALOG_PATH'] = catalogPath
    const surface = buildModelSurfaceSync()
    expect(surface.catalogLoaded).toBe(true)
    expect(surface.models).toHaveLength(3)
    expect(surface.defaultModel).toBe('Model-A-Primary')
    expect(surface.catalogVersion).toBe(2)
  })

  it('populates alias map from catalog aliases', () => {
    const catalogPath = join(tmpDir, 'catalog.json')
    writeFileSync(catalogPath, JSON.stringify(makeCatalog()))
    process.env['OWLCODA_CATALOG_PATH'] = catalogPath
    const surface = buildModelSurfaceSync()
    expect(surface.aliasMap['default']).toBe('Model-A-Primary')
    expect(surface.aliasMap['default']).toBe('Model-A-Primary')
    expect(surface.aliasMap['heavy']).toBe('Model-B-Heavy')
    expect(surface.aliasMap['fast']).toBe('Model-C-Fast')
    expect(surface.aliasMap['fast']).toBe('Model-C-Fast')
  })

  it('marks default model with isDefault=true', () => {
    const catalogPath = join(tmpDir, 'catalog.json')
    writeFileSync(catalogPath, JSON.stringify(makeCatalog()))
    process.env['OWLCODA_CATALOG_PATH'] = catalogPath
    const surface = buildModelSurfaceSync()
    const defaultModel = surface.models.find(m => m.isDefault)
    expect(defaultModel).toBeDefined()
    expect(defaultModel!.id).toBe('Model-A-Primary')
  })

  it('sets intent defaults from catalog', () => {
    const catalogPath = join(tmpDir, 'catalog.json')
    writeFileSync(catalogPath, JSON.stringify(makeCatalog()))
    process.env['OWLCODA_CATALOG_PATH'] = catalogPath
    const surface = buildModelSurfaceSync()
    expect(surface.intentDefaults['general_chat']).toBe('Model-A-Primary')
    expect(surface.intentDefaults['heavy_reasoning']).toBe('Model-B-Heavy')
  })

  it('all models have unknown availability in sync mode (no router probe)', () => {
    const catalogPath = join(tmpDir, 'catalog.json')
    writeFileSync(catalogPath, JSON.stringify(makeCatalog()))
    process.env['OWLCODA_CATALOG_PATH'] = catalogPath
    const surface = buildModelSurfaceSync()
    for (const m of surface.models) {
      expect(m.availability).toBe('unknown')
    }
    expect(surface.routerModels).toHaveLength(0)
  })

  it('returns empty surface when no catalog found', () => {
    process.env['OWLCODA_CATALOG_PATH'] = '/nonexistent/catalog.json'
    const surface = buildModelSurfaceSync()
    expect(surface.catalogLoaded).toBe(false)
    expect(surface.models).toHaveLength(0)
    expect(surface.defaultModel).toBe('')
  })
})

describe('resolveModelName', () => {
  let surface: ModelSurface

  beforeEach(() => {
    const catalogPath = join(tmpDir, 'catalog.json')
    writeFileSync(catalogPath, JSON.stringify(makeCatalog()))
    process.env['OWLCODA_CATALOG_PATH'] = catalogPath
    surface = buildModelSurfaceSync()
  })

  it('resolves exact model ID', () => {
    expect(resolveModelName(surface, 'Model-A-Primary')).toBe('Model-A-Primary')
    expect(resolveModelName(surface, 'Model-B-Heavy')).toBe('Model-B-Heavy')
  })

  it('resolves alias', () => {
    expect(resolveModelName(surface, 'default')).toBe('Model-A-Primary')
    expect(resolveModelName(surface, 'heavy')).toBe('Model-B-Heavy')
    expect(resolveModelName(surface, 'fast')).toBe('Model-C-Fast')
  })

  it('resolves partial match (case insensitive)', () => {
    expect(resolveModelName(surface, 'primary')).toBe('Model-A-Primary')
    expect(resolveModelName(surface, 'heavy')).toBe('Model-B-Heavy')
    expect(resolveModelName(surface, 'fast')).toBe('Model-C-Fast')
  })

  it('strips date suffix from timestamped alias names', () => {
    expect(resolveModelName(surface, 'default-20250514')).toBe('Model-A-Primary')
  })

  it('falls back to default for unknown input', () => {
    expect(resolveModelName(surface, 'totally-unknown-model')).toBe('Model-A-Primary')
  })

  it('handles empty input by returning default', () => {
    expect(resolveModelName(surface, '')).toBe('Model-A-Primary')
  })
})

describe('getRouterModelName', () => {
  it('returns platform ID when router has it', () => {
    const surface: ModelSurface = {
      models: [],
      defaultModel: 'Model-A',
      intentDefaults: {},
      aliasMap: { 'short-a': 'Model-A' },
      catalogVersion: 1,
      catalogLoaded: true,
      routerModels: ['Model-A', 'Model-B'],
    }
    expect(getRouterModelName(surface, 'Model-A')).toBe('Model-A')
  })

  it('returns router alias when direct ID not in router models', () => {
    const surface: ModelSurface = {
      models: [],
      defaultModel: 'Model-A-Full-Name',
      intentDefaults: {},
      aliasMap: { 'short-a': 'Model-A-Full-Name' },
      catalogVersion: 1,
      catalogLoaded: true,
      routerModels: ['short-a', 'Model-B'],
    }
    expect(getRouterModelName(surface, 'Model-A-Full-Name')).toBe('short-a')
  })

  it('falls back to platform ID when no router match', () => {
    const surface: ModelSurface = {
      models: [],
      defaultModel: 'Model-X',
      intentDefaults: {},
      aliasMap: {},
      catalogVersion: 1,
      catalogLoaded: true,
      routerModels: ['other-model'],
    }
    expect(getRouterModelName(surface, 'Model-X')).toBe('Model-X')
  })
})
