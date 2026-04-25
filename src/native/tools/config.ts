/**
 * OwlCoda Native Config Tool
 *
 * Get or set runtime configuration settings.
 * Omitting `value` reads the current value; providing `value` sets it.
 *
 * Upstream parity notes:
 * - Upstream ConfigTool supports ~20 settings with type coercion
 * - Validates enum options, writes to global/project config
 * - Our version: reads from OwlCoda config + environment
 */

import type { ConfigInput, NativeToolDef, ToolResult } from './types.js'
import { getThemeName, setTheme, THEME_NAMES, type ThemeName } from '../tui/colors.js'

/** Known settings and their current getters/setters. */
interface SettingDef {
  get: () => unknown
  set?: (v: unknown) => void
  options?: string[]
  type: 'string' | 'boolean' | 'number'
}

export function createConfigTool(): NativeToolDef<ConfigInput> {
  const settings: Record<string, SettingDef> = {
    theme: {
      get: () => getThemeName(),
      set: (v) => setTheme(v as ThemeName),
      options: [...THEME_NAMES],
      type: 'string',
    },
    model: {
      get: () => process.env.OWLCODA_MODEL ?? process.env.MODEL ?? '(not set)',
      type: 'string',
    },
    verbose: {
      get: () => process.env.OWLCODA_VERBOSE === 'true',
      set: (v) => { process.env.OWLCODA_VERBOSE = String(v) },
      type: 'boolean',
    },
    autoCompact: {
      get: () => process.env.OWLCODA_AUTO_COMPACT !== 'false',
      set: (v) => { process.env.OWLCODA_AUTO_COMPACT = String(v) },
      type: 'boolean',
    },
  }

  return {
    name: 'Config',
    description:
      'Get or set OwlCoda runtime settings. Omit value to read; provide value to write.',

    async execute(input: ConfigInput): Promise<ToolResult> {
      const { setting, value } = input
      const def = settings[setting]

      if (!def) {
        const known = Object.keys(settings).join(', ')
        return {
          output: `Unknown setting "${setting}". Known settings: ${known}`,
          isError: true,
        }
      }

      // GET operation
      if (value === undefined) {
        const current = def.get()
        const extras = def.options ? ` (options: ${def.options.join(', ')})` : ''
        return {
          output: `${setting} = ${JSON.stringify(current)}${extras}`,
          isError: false,
          metadata: { operation: 'get', setting, value: current },
        }
      }

      // SET operation
      if (!def.set) {
        return {
          output: `Setting "${setting}" is read-only.`,
          isError: true,
        }
      }

      // Type coercion
      let finalValue: unknown = value
      if (def.type === 'boolean' && typeof value === 'string') {
        const lower = value.toLowerCase().trim()
        if (lower === 'true') finalValue = true
        else if (lower === 'false') finalValue = false
      }

      // Validate against options
      if (def.options && !def.options.includes(String(finalValue))) {
        return {
          output: `Invalid value "${value}" for ${setting}. Options: ${def.options.join(', ')}`,
          isError: true,
        }
      }

      const previous = def.get()
      def.set(finalValue)

      return {
        output: `Set ${setting} = ${JSON.stringify(finalValue)} (was ${JSON.stringify(previous)})`,
        isError: false,
        metadata: { operation: 'set', setting, previousValue: previous, newValue: finalValue },
      }
    },
  }
}
