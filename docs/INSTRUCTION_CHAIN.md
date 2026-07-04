# Instruction Chain

`owlcoda instructions inspect --json` reports the instruction sources that the
runtime would load before starting a model turn.

The command is an audit surface. It must show both loaded sources and skipped
candidate sources so users can debug why a rule did or did not apply.

## Schema v1

The top-level object has:

- `schemaVersion`: currently `1`.
- `kind`: always `owlcoda_instruction_chain`.
- `cwd`: resolved working directory used for project discovery.
- `count`: number of loaded sources.
- `limits`: discovery limits used for this inspection.
- `sources`: loaded instruction sources in prompt order.
- `skipped`: existing candidate sources that were not loaded.

`limits.maxRuleFiles` is applied per scanned ancestor directory, not as a
global cap across the whole instruction chain.

`schemaVersion: 1` allows additive fields. Consumers must ignore unknown
top-level fields and unknown fields on `sources` or `skipped` entries.

## Skipped Reasons

`skipped.reason` is an open string enum. Consumers must tolerate unknown future
values and display them as diagnostics instead of failing closed.

Current reasons:

- `empty`: file exists but has no usable content.
- `not-file`: path exists but is not a regular file.
- `read-error`: file exists but could not be read, including broken symlinks.
- `path-scoped-rule`: `.claude/rules/*.md` has `paths:` frontmatter and is not
  loaded into every startup prompt.
- `shadowed-by-override`: `AGENTS.override.md` was loaded and the same
  directory's `AGENTS.md` was skipped.
- `fallback-not-used`: a lower-priority user fallback exists but an earlier user
  instruction candidate already determined the fallback outcome.

Future reasons may include truncation or explicit settings exclusions.
