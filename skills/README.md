# OwlCoda Curated Skill Pack

This directory ships a small **curated methodology pack** that
OwlCoda's native REPL can match against and inject into the system
prompt at request time (the L2 skill-injection feature). It is **not**
a third-party product's skill catalog and is not intended as a
plug-compatible replacement for any external skill ecosystem.

## What's here

The pack is intentionally lean. It covers cross-cutting engineering
methodology that holds up across language and project type:

- `architecture/` — system-design reasoning patterns
- `collaboration/` — multi-agent and human-in-loop patterns
- `debugging/` — systematic debugging and root-cause tracing
- `doc/` — documentation patterns
- `goal-driven-project-loop/` — project-execution loop methodology
- `phase-prompting/`, `round-prompting/` — prompt-engineering
  methodology
- `problem-solving/`, `research/` — analytical methodology
- `security-best-practices/`, `security-threat-model/`,
  `security-ownership-map/` — security review methodology
- `testing/` — testing methodology
- `using-skills/` — how the skill system itself works

## What's not here

Third-party SaaS / platform helper skills (notion, linear, sentry,
figma, render/vercel/netlify deploy, openai-docs, chatgpt-apps,
cloudflare-deploy, etc.) are **not** shipped in-tree. If you want
those workflows, install a third-party skill pack into
`~/.owlcoda/skills/`. OwlCoda's runtime treats local installs and
the in-tree pack identically.

## Provenance

Some methodology in this pack is inspired by the broader open-source
software-engineering community. Where individual files explicitly cite
external sources, those citations remain. Otherwise the wording in
this pack reflects OwlCoda's own framing and is licensed under the
project license (Apache-2.0).
