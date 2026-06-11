# Changelog

All notable changes to OwlCoda public releases are documented here.

## [0.15.1] — 2026-06-11

First npm package release on the GPL source line.

### Changed

- Moved the public npm install line from the historical `0.14.x` stream to
  `0.15.x`.
- Added the post-source-open runtime fixes already shipped through `0.14.64`
  to the public source line, including mode visibility, submission recovery,
  terminal width hardening, headless exports, third-party skill hardening, and
  streaming usage accounting.
- Synced the bilingual README and Admin model screenshot into the npm package
  surface.
- Updated package metadata, lockfile metadata, Admin display version, and
  corresponding-source wording for `0.15.1`.

### Notes

- This release must be paired with public source tag `v0.15.1`.
- Existing public source tag `v0.15.0` remains the GPL source-open boundary
  tag and is not moved.

## [0.15.0] — 2026-06-04

License boundary and public source availability.

### Changed

- Relicensed the OwlCoda core package from `Apache-2.0` to
  `GPL-3.0-or-later` starting with the `0.15.0` boundary.
- Added `SOURCE.md` to make the corresponding-source requirement explicit for
  npm packages that ship compiled `dist/`.
- Updated package metadata, lockfile metadata, OpenAPI license metadata,
  README distribution posture, product truth, NOTICE, CONTRIBUTING, and
  SECURITY docs for the GPL source line.

### Notes

- Commercial, OEM, or embedded distribution is handled through a separate
  maintainer license path.
- Historical published versions remain under the license terms that accompanied
  those versions when they were published.

## Older Releases

Historical package versions remain under the license terms that accompanied those versions when they were published.
