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

### Protocol Interoperability vs Affiliation

OwlCoda implements two widely-deployed wire formats so that users can
plug their existing local runtime into it without rewriting the
runtime:

1. The Messages-shaped API (originated by Anthropic and now implemented
   by many independent open-source servers) — incoming `/v1/messages`
   requests are accepted in this shape and translated as needed.
2. The OpenAI Chat Completions wire format — outgoing requests to
   user-configured backends use this shape because most local
   inference runtimes (Ollama, LM Studio, vLLM, etc.) expose it.

Implementing these wire formats is a technical interoperability
choice, not a brand affiliation. Where the codebase contains the
literal strings `Anthropic`, `Anthropic-compatible`,
`anthropic-version`, `/v1/messages`, or imports the public
`@anthropic-ai/sdk` package, those references are protocol-level,
exist solely to maintain over-the-wire compatibility, and do not
constitute or imply:

- endorsement by, or sponsorship from, Anthropic, OpenAI, or any
  other third party;
- any affiliation, partnership, or contractual relationship with
  those parties; or
- a claim that OwlCoda is a substitute for, or a derivative of,
  any third-party product.

The `@anthropic-ai/sdk` package is listed as a `devDependency` only
and is used by `tests/sdk-verify.ts` as an interoperability sanity
check against OwlCoda's own server implementation. It is not loaded
by the OwlCoda runtime.

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

### Skills Methodology Attribution

The `skills/` tree in this repository is a **curated methodology pack**.
While the prose in each `SKILL.md` was rewritten to fit OwlCoda's tone
and toolset, several skills are conceptually derived from — or adapted
from agent patterns in — the upstream projects listed below. Their
contributions are acknowledged here in the spirit of, and where
applicable in compliance with, their respective licenses.

#### Microsoft Amplifier (https://github.com/microsoft/amplifier)

`skills/research/tracing-knowledge-lineages/` is adapted from the
`knowledge-archaeologist` agent in Microsoft's Amplifier project
(commit `2adb63f858e7d760e188197c8e8d4c1ef721e2a6`, 2025-10-10). A
per-skill attribution lives at `skills/research/ABOUT.md`. Amplifier
is distributed under the MIT License; copyright is retained by
Microsoft Corporation and the Amplifier contributors.

```
MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### Upstream skill-pack ecosystem (obra/superpowers-skills and related)

Several names and structural conventions in this pack
(`brainstorming`, `writing-plans`, `executing-plans`,
`subagent-driven-development`, `using-git-worktrees`,
`verification-before-completion`, `systematic-debugging`,
`test-driven-development`, `receiving-code-review`,
`requesting-code-review`, and the meta-pattern of pairing each skill
with a `SKILL.md` front-matter file) trace back to a public
"superpowers"-style skill-pack ecosystem in which the
`obra/superpowers-skills` repository is a notable upstream. Where
specific `SKILL.md` bodies in this tree were adapted from that
ecosystem, the original maintainers' authorship is acknowledged here.
Distribution under the upstream license terms applies to any text that
remains substantially derivative; OwlCoda contributors are responsible
for keeping this list accurate as the pack evolves.

If you are an upstream author and believe a specific skill in this
tree warrants more granular per-file attribution (or removal), please
open an issue at https://github.com/yeemio/owlcoda/issues and we will
correct it promptly.

#### General methodology / prompt-engineering practice

A subset of skills (e.g. systematic debugging, code review checklists,
TDD discipline) reflect widely-published software-engineering
practice — not any single proprietary source — and are included as
generic methodology rather than as derivatives of any one author's
work. Where specific phrasing was retained from a particular external
prompt or document, that source is attributed in the relevant
`SKILL.md` or sibling `ABOUT.md` file.

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
