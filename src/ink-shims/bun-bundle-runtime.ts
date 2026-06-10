// Runtime shim for bun:bundle — feature() always returns false in Node.js
export function feature(_name: string): boolean {
  return false
}
