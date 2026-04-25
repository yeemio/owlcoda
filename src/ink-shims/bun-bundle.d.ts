// Stub for bun:bundle — upstream uses this for compile-time feature flags.
// In OwlCoda (Node.js), feature() always returns false.
declare module 'bun:bundle' {
  export function feature(name: string): boolean
}
