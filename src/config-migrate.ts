/**
 * Config migration — auto-upgrade old config formats to current schema.
 * Each migration has a version number and a transform function.
 */

export interface Migration {
  version: number
  description: string
  migrate: (config: Record<string, unknown>) => Record<string, unknown>
}

/**
 * Ordered list of migrations. Each bumps configVersion by 1.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Add configVersion field',
    migrate: (config) => ({ ...config, configVersion: 1 }),
  },
  {
    version: 2,
    description: 'Normalize routerUrl (remove trailing slash)',
    migrate: (config) => {
      const url = typeof config.routerUrl === 'string' ? config.routerUrl.replace(/\/+$/, '') : config.routerUrl
      return { ...config, routerUrl: url, configVersion: 2 }
    },
  },
  {
    version: 3,
    description: 'Ensure models have backendModel field',
    migrate: (config) => {
      const models = Array.isArray(config.models) ? config.models : []
      const updated = models.map((m: Record<string, unknown>) => ({
        ...m,
        backendModel: m.backendModel || m.id,
      }))
      return { ...config, models: updated, configVersion: 3 }
    },
  },
  {
    version: 4,
    description: 'Add default port if missing',
    migrate: (config) => ({
      ...config,
      port: config.port || 8019,
      configVersion: 4,
    }),
  },
]

export const CURRENT_CONFIG_VERSION = MIGRATIONS.length

export interface MigrationResult {
  fromVersion: number
  toVersion: number
  applied: string[]
  config: Record<string, unknown>
}

/**
 * Apply all pending migrations to a config object.
 */
export function migrateConfig(config: Record<string, unknown>): MigrationResult {
  const fromVersion = typeof config.configVersion === 'number' ? config.configVersion : 0
  const applied: string[] = []
  let current = { ...config }

  for (const migration of MIGRATIONS) {
    if (migration.version > fromVersion) {
      current = migration.migrate(current)
      applied.push(`v${migration.version}: ${migration.description}`)
    }
  }

  return {
    fromVersion,
    toVersion: CURRENT_CONFIG_VERSION,
    applied,
    config: current,
  }
}

/**
 * Check if a config needs migration.
 */
export function needsMigration(config: Record<string, unknown>): boolean {
  const version = typeof config.configVersion === 'number' ? config.configVersion : 0
  return version < CURRENT_CONFIG_VERSION
}

/**
 * Format migration result for display.
 */
export function formatMigrationResult(result: MigrationResult): string {
  if (result.applied.length === 0) {
    return `Config is up to date (version ${result.toVersion}).`
  }
  const lines = [
    `Migrated config from version ${result.fromVersion} → ${result.toVersion}:`,
    ...result.applied.map(a => `  ✓ ${a}`),
  ]
  return lines.join('\n')
}
