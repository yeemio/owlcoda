// Fork-local type declarations for the upstream Ink fork.
// Covers missing type declarations for npm packages and Bun runtime.

declare const Bun: any

declare module 'stack-utils' {
  class StackUtils {
    static nodeInternals(): RegExp[]
    constructor(options?: { cwd?: string; internals?: RegExp[] })
    clean(stack: string): string
    parseLine(line: string): { file?: string; line?: number; column?: number; function?: string } | null
  }
  export default StackUtils
}

declare module 'bidi-js' {
  const bidiFactory: () => {
    getReorderSegments(text: string, dir: 'ltr' | 'rtl'): Array<[number, number]>
    getEmbeddingLevels(text: string, dir: 'ltr' | 'rtl' | 'auto'): { levels: Uint8Array; paragraphs: Array<{ start: number; end: number; level: number }> }
  }
  export default bidiFactory
}

declare module 'react-reconciler' {
  const createReconciler: any
  export default createReconciler
  export type FiberRoot = any
}

declare module 'react-reconciler/constants.js' {
  export const ConcurrentRoot: number
  export const LegacyRoot: number
  export const DefaultEventPriority: number
  export const DiscreteEventPriority: number
  export const ContinuousEventPriority: number
  export const NoEventPriority: number
}

declare module 'semver' {
  export function gte(a: string, b: string): boolean
  export function gt(a: string, b: string): boolean
  export function parse(v: string): { major: number; minor: number; patch: number } | null
  export function coerce(v: string | null | undefined): { version: string } | null
  const semver: {
    gte: typeof gte
    gt: typeof gt
    parse: typeof parse
    coerce: typeof coerce
  }
  export default semver
}
