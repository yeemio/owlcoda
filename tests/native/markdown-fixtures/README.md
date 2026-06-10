## Markdown renderer golden fixtures

One case per directory under `cases/`. Each directory has:

- `in.md` — the raw markdown the model emits (inputs are typed verbatim,
  including the model "glue" pathologies we recover from)
- `out.txt` — the rendered output **with ANSI stripped**, with trailing
  whitespace per line removed, blank-run collapsed, leading/trailing blanks
  trimmed (the same shape the path-equivalence tests use)
- `meta.json` (optional) — `{ widths?: number[], skipPaths?: string[] }`
  to override defaults. Default widths are `[80, 100, 120]`. `skipPaths`
  can list any of `full | stream-1chunk | stream-line | stream-token` to
  exclude a path from comparison (only when the case is a known
  path-divergence we accept).

The test runner (`markdown-fixture-suite.test.ts`) loads every directory
and asserts:

1. **Path equivalence** — full-pass / 1-chunk / line-by-line / token-by-token
   stream all produce the same normalized output.
2. **Snapshot match** — the normalized output equals `out.txt` byte-for-byte
   after the same normalization.
3. **Multi-width stability** — for each width in `widths`, `out.txt` is
   width-independent (or, if width-sensitive, an additional
   `out.<width>.txt` file is checked).

### Refreshing a fixture

When a renderer change is intentional, regenerate the snapshot:

```sh
OWLCODA_FIXTURE_REGEN=1 npx vitest run tests/native/markdown-fixtures
```

This rewrites every `out.txt` to whatever the current renderer produces.
**Always diff the result by hand before committing** — a regen turns
regressions into "passing" tests.

### Naming

Cases are named `NN-short-slug/` where `NN` is a stable two-digit prefix
(used for ordering test reports). Avoid version numbers in slugs; the
case captures the *behavior*, not the release that introduced it.
