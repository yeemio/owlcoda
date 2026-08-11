# `@owlcoda/attest`

`@owlcoda/attest` is OwlCoda RunKit's unsigned, read-only verification plane.
It verifies Quick Receipt V1 artifacts, Formal public verification bundles, and
local `OwlCodaAttestationRefV1` references without importing the private
mutation Core.

The package is an unsigned V1 distribution candidate. It is intentionally
marked private until naming clearance and release authorization exist.
`consumer-surface-v1.json` freezes the complete command, schema, reference,
issue-code, compatibility, privacy, metrics, and unsupported-claim covenant.

## CLI

```text
owlcoda-attest attest <receipt-or-bundle.json> [--workspace <path>] [--json]
owlcoda-attest resolve <attestation-ref.json> --store <path> [--store <path>...] [--workspace <path>] [--json]
```

Resolution searches only the explicitly supplied local stores. Both commands
perform zero network requests and always report `authorizationGranted: false`.
`owlcoda-attest --help` is the complete installed consumer entry point.
Without `--workspace`, an otherwise-valid Quick receipt is `INDETERMINATE`: the
verifier checks receipt-internal relationships, does not read receipt-declared
output paths, and reports `current_workspace_not_checked`. A deterministically
invalid receipt remains `NO_GO`. Supply `--workspace` for a `GO` that checks the
selected current checkout and bound output materials. Formal public bundles
remain self-contained.

## API

```js
import {
  attestFile,
  createOfflineAttestationBundle,
  createAttestationRef,
  parseOfflineAttestationBundle,
  parseAttestationRef,
  resolveAttestationRef,
  verifyBundle,
} from "@owlcoda/attest";
```

Offline bundle helpers are pure and read-only. Producer-side file export and
store import are exposed by `owlcoda runkit store`; this public package never
writes a receipt store.

Quick `GO` means the captured command, receipt material, receipt-bound source
relationship, runtime context, and supported Core identity verify under the
unsigned Quick policy. When `--workspace` is supplied, it also binds the
selected current checkout. It does not mean Formal acceptance, independent
review, Git authority, release authority, or business-action authority.

The N/N-1 covenant, honest unsigned limits, and upgrade procedure are defined
in the repository documentation under
`docs/architecture/runkit-attestation-v1/`. Rollback preserves historical
receipts but does not require N-1 to trust an unknown future Core identity.

The packed candidate includes its GPL-3.0-or-later license, a package-level
SPDX 2.3 SBOM, and the frozen Consumer Surface V1 manifest. Local metrics never
send telemetry and are not a performance target. They describe local receipt
state; separate consumption must be evidenced by a caller-owned attestation
result.
