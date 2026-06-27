import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as desktop from '../src/desktop.js'
import {
  bootstrapDesktopProductShell,
  loadDesktopProductShellViewModel,
  connectDesktopProductShellLiveEvents,
  runDesktopProductShellSmoke,
  buildDesktopModelComparisonPanel,
  buildDesktopRuntimeFactsDrilldown,
  DEFAULT_DESKTOP_CAPABILITY_GATE_POLICY,
} from '../src/desktop.js'

describe('desktop product shell public export', () => {
  it('re-exports the product-shell contract helpers from one stable facade', () => {
    expect(bootstrapDesktopProductShell).toBeTypeOf('function')
    expect(loadDesktopProductShellViewModel).toBeTypeOf('function')
    expect(connectDesktopProductShellLiveEvents).toBeTypeOf('function')
    expect(runDesktopProductShellSmoke).toBeTypeOf('function')
    expect(buildDesktopModelComparisonPanel).toBeTypeOf('function')
    expect(buildDesktopRuntimeFactsDrilldown).toBeTypeOf('function')
    expect(DEFAULT_DESKTOP_CAPABILITY_GATE_POLICY.requiredStableMethods).toContain('project/list')
    expect(Object.keys(desktop)).toEqual(expect.arrayContaining([
      'bootstrapDesktopProductShell',
      'loadDesktopProductShellViewModel',
      'connectDesktopProductShellLiveEvents',
      'runDesktopProductShellSmoke',
      'buildDesktopModelComparisonPanel',
      'buildDesktopRuntimeFactsDrilldown',
      'DEFAULT_DESKTOP_CAPABILITY_GATE_POLICY',
    ]))
  })

  it('maps owlcoda/desktop to the typed built desktop facade in package exports', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    expect(pkg.exports['./desktop']).toEqual({
      types: './dist/desktop.d.ts',
      import: './dist/desktop.js',
      default: './dist/desktop.js',
    })
    expect(Object.keys(pkg.exports)).not.toEqual(expect.arrayContaining([
      './native/app-server/desktop-product-shell',
      './native/app-server/desktop-product-shell-view-model',
      './native/app-server/desktop-product-shell-live-events',
      './native/app-server/desktop-runtime-facts-drilldown',
    ]))
  })
})
