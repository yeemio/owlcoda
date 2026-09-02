# Contributing to OwlCoda

Thanks for helping build trustworthy, local-first AI business execution.

This public repository is OwlCoda's corresponding-source, documentation,
Issue, Release, and public trust surface. Day-to-day product development happens
in a private source repository. Public issues, reproducible product feedback,
documentation fixes, security reports, and architecture questions are welcome;
larger source proposals should begin with an issue so product scope and license
rights are agreed before implementation starts.

## Good public reports

A useful report states:

- exact `owlcoda --version`, Node.js version, and operating system;
- expected behavior and observed behavior;
- the smallest safe reproduction;
- whether the issue affects the current 0.18 runtime or a future product idea;
- relevant logs or screenshots with credentials, private source, and business
  data removed.

For OwlRunKit-specific continuity, receipt, Project Driver, or delivery issues,
use the [OwlRunKit repository](https://github.com/yeemio/owlrunkit).

## Product boundary

Proposals should preserve these boundaries:

- OwlCoda owns Business Truth and the causal business-execution envelope;
- models and coding agents are replaceable executors;
- evidence, execution, admitted result, qualification, human review, and
  BusinessAction remain separate states;
- current public capabilities must not be confused with future architecture;
- telemetry and external data collection remain opt-in and disable-able;
- no accepted candidate or green test silently grants Git, release, deployment,
  production, money, automation, or business authority.

## License and contribution rights

OwlCoda core is distributed under `GPL-3.0-or-later` from the 0.15.0 boundary.
Commercial, OEM, or embedded distribution uses a separate maintainer license
path.

Until a CLA or copyright-assignment process is published, external source-code
contributions are accepted only after maintainer approval. Small documentation
fixes are welcome; for code, contracts, or substantial docs, open an issue before
writing a large patch so the contribution and dual-license path is explicit.

## Working with the public source

The tagged public source is sufficient to inspect and rebuild the corresponding
release. For the current branch:

```bash
git clone https://github.com/yeemio/owlcoda.git
cd owlcoda
npm install
npm run build
npm test
```

On Windows, keep build-critical entrypoints as real files rather than relying on
symlinks. Use a user-owned test backend and never commit API keys or local
configuration.

If a source proposal has maintainer approval:

- keep commits single-purpose;
- explain why the change is needed;
- add focused verification for changed behavior;
- run the build and relevant tests;
- disclose skipped checks and known limits honestly;
- do not change product claims merely to make a test pass.

## Code of conduct

Be respectful. Critique ideas, not people. Harassment, personal attacks, and
discriminatory language are not accepted.

For private conduct or security reports, use the contact in
[SECURITY.md](SECURITY.md).
