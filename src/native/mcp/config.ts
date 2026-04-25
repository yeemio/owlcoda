/**
 * MCP configuration loader.
 *
 * Discovers MCP server configs from:
 *   1. .mcp.json in project root (project-scoped)
 *   2. ~/.owlcoda/mcp.json (OwlCoda-specific global)
 *
 * Merges project-scoped over global (project wins on name collision).
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { MCPServerConfig, MCPConfigFile } from './types.js'

/** Search paths for MCP config, in priority order (later wins on collision). */
function configPaths(cwd: string): string[] {
  const home = homedir()
  return [
    join(home, '.owlcoda', 'mcp.json'),
    join(cwd, '.mcp.json'),
  ]
}

/** Try to read and parse a JSON file. Returns null on any error. */
function tryReadJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Validate a single server config entry. */
function isValidServerConfig(val: unknown): val is MCPServerConfig {
  if (typeof val !== 'object' || val === null) return false
  const obj = val as Record<string, unknown>
  return typeof obj.command === 'string' && obj.command.length > 0
}

/**
 * Load all MCP server configs from known locations.
 * Returns a map of server-name → config.
 */
export function loadMCPConfig(cwd: string = process.cwd()): Map<string, MCPServerConfig> {
  const servers = new Map<string, MCPServerConfig>()

  for (const path of configPaths(cwd)) {
    const data = tryReadJson(path)
    if (!data) continue

    // Extract mcpServers key (standard location)
    const mcpServers = (data.mcpServers ?? data) as Record<string, unknown>
    if (typeof mcpServers !== 'object') continue

    for (const [name, val] of Object.entries(mcpServers)) {
      // Skip non-server entries when config files include extra top-level keys.
      if (!isValidServerConfig(val)) continue

      servers.set(name, {
        command: val.command,
        args: Array.isArray(val.args) ? val.args.map(String) : undefined,
        env: typeof val.env === 'object' && val.env !== null
          ? Object.fromEntries(Object.entries(val.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
          : undefined,
        cwd: typeof val.cwd === 'string' ? val.cwd : undefined,
      })
    }
  }

  return servers
}
