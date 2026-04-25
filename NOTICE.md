# NOTICE

## OwlCoda Positioning

OwlCoda is an independent local AI coding platform. It is not affiliated with
any external coding assistant vendor.

Third-party product names may appear where they are needed for protocol
interoperability, optional user-provided provider integrations, migration
history, or competitive analysis. The default npm release package is limited to
the OwlCoda runtime, branding assets, configuration examples, and public
release documents; uncurated skill packs or workflow examples are not part of
that package unless they are explicitly reviewed with their own provenance.

### What OwlCoda Provides

OwlCoda provides:
- Protocol translation layer (messages API ↔ OpenAI Chat Completions)
- Local model platform integration (Ollama, LM Studio, vLLM)
- Native REPL, tool orchestration, and session workflows
- Production infrastructure (health monitoring, rate limiting, circuit breakers)
- Extended REPL commands and observability

### What OwlCoda Does NOT Provide

OwlCoda does not claim to be any third-party coding assistant, does not ship a
third-party branded UI, and does not rely on an external vendor CLI as its
primary product surface.

## Third-Party Source Attributions

OwlCoda incorporates source code derived from the following third-party
projects. Their original copyright notices and MIT permission text are
reproduced below as required by their licenses.

### Ink (https://github.com/vadimdemedes/ink)

The `src/ink/` directory contains a fork of the Ink terminal-UI library
originally authored by Vadim Demedes. OwlCoda's fork extends Ink with
ScrollBox / viewport-culling / sticky-scroll primitives needed by the
native REPL, but the underlying reconciler, layout, renderer, DOM, event,
and component code remain derivative of upstream Ink.

```
MIT License

Copyright (c) Vadim Demedes <vadimdemedes@hey.com> (vadimdemedes.com)

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
```

A copy of this attribution also lives at `src/ink/ATTRIBUTION.md` so it
travels with the fork in any redistribution.

### Direct Runtime Dependencies

OwlCoda's published tarball ships only `dist/`; runtime dependencies are
resolved by `npm install` and their full license texts are available
under `node_modules/<pkg>/LICENSE` after install. The list below is
provided for transparency; it does not replace the per-package license
files that npm fetches automatically.

| Package | License |
|---|---|
| `@anthropic-ai/sdk` (devDependency, type-only import + verify script) | MIT |
| `@commander-js/extra-typings` | MIT |
| `@growthbook/growthbook` | MIT |
| `@modelcontextprotocol/sdk` | MIT |
| `@opentelemetry/*` (api, core, sdk-logs, sdk-metrics, sdk-trace-base, resources, api-logs, semantic-conventions) | Apache-2.0 |
| `axios`, `chalk`, `chokidar`, `marked`, `react`, `react-reconciler`, `ws`, `zod`, `undici`, `execa`, `turndown`, `xss`, `yaml`, others | MIT |
| `cacache`, `cli-highlight`, `semver`, `signal-exit`, `yaml` | ISC |
| `diff` | BSD-3-Clause |
| `lru-cache` | BlueOak-1.0.0 |
| `ink` (npm — co-installed alongside the in-tree fork in `src/ink/`) | MIT (Vadim Demedes) |

No GPL / AGPL / SSPL / Business Source / Commons Clause / Elastic
License dependencies are present in the transitive graph (verified via
`npm ls --all`).
