# Contributing to OwlCoda

[English](CONTRIBUTING.md) · [中文](CONTRIBUTING.zh.md)

Thanks for taking the time. OwlCoda is a Developer Preview and the
codebase moves fast, so before you sink real time into a change please
file an issue first or run the idea past the maintainer. This saves both
sides from wasted work on something that is already being rewritten.

## Development setup

```bash
git clone https://github.com/yeemio/owlcoda.git
cd owlcoda
npm install
npm run build
npm test
```

On Windows, the default Git setting is often `core.symlinks=false`.
Do not add build-critical symlink-only TypeScript entrypoints: use real
bridge files with ESM re-exports so `npm install && npm run build`
continues to work in PowerShell, cmd, Git Bash, and WSL.

You'll want a local OpenAI-compatible backend running for end-to-end
work. `ollama serve` with `qwen2.5-coder:7b` pulled is the cheapest path;
LM Studio and vLLM both work too. See the README for quickstart commands.

## Useful scripts

| Command | What it does |
|---|---|
| `npm run build` | TypeScript compile to `dist/` |
| `npm run dev` | Run `src/cli.ts` directly via `tsx` (no rebuild) |
| `npm test` | Vitest suite — ~3300 tests, ~30s |
| `npm run smoke:fast` | Build + proxy health check |
| `npm run smoke` | Full smoke (spins up a real backend) |

## Coding conventions

- **TypeScript strict**, no implicit `any`. `npm run build` must be clean.
- **Tests live next to the surface they cover**, not globally. New code
  gets tests; bug fixes get regression tests.
- **Default to no comments**. Explain *why*, not *what*. Commit messages
  are for context; identifiers for meaning.
- **No third-party vendor paths hardcoded in product code.** OwlCoda
  positions as an independent platform — please don't re-introduce
  probes for competing products' vendored binaries.
- **Privacy defaults OFF.** Any new collection / telemetry / network
  egress must be opt-in, documented, and disable-able via env var.

## Commit / PR style

- Single-purpose commits. Prefer many small commits over one giant one.
- First-line style: `fix(area): short description` or `feat(area): …`
  matching the convention used in `git log --oneline`.
- PR description must say *why* the change is needed, not just *what*.
  Screenshots or asciinemas help for UX changes.
- Open PRs against `main`. There is no release branch yet.

## Testing a change end-to-end

Before requesting review:

1. `npm run build` — must pass clean.
2. `npm test` — must pass (or you must explain the failure).
3. For UX/TUI changes: run `owlcoda` locally against a real backend and
   verify the feature manually. Type-checking and unit tests verify
   code correctness, not user experience.
4. Update `CHANGELOG.md` with a short entry in the current
   `## [0.1.x]` section.

## Areas where help is welcome

- **TUI polish** — scrollback watermark (see `docs/ROADMAP.md`), theme
  variants, accessibility modes.
- **Backend adapters** — more local OpenAI-compatible backends under
  `src/backends/`.
- **Skills** — domain packs under `skills/` for workflows you use daily.
- **Documentation** — screenshots, gifs, concrete use-case walkthroughs.

Anything larger than a docs fix: please open an issue first.

## Code of Conduct

Be respectful. Critique ideas, not people. Assume good faith.
Harassment, personal attacks, or discriminatory language are
grounds for removal from issues, PRs, and discussions.

For private reports of conduct problems, email the maintainer
(see `package.json` `author`).
