// Shim for react/compiler-runtime used by upstream's React-compiled components.
// _c(size) returns an array pre-filled with a sentinel so the memoization
// cache works identically to the real compiler runtime.

const sentinel = Symbol.for("react.memo_cache_sentinel")

export function c(size: number): any[] {
  return new Array(size).fill(sentinel)
}
