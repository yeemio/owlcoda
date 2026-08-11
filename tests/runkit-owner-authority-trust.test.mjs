import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { generateKeyPairSync, sign } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ownerAuthorityArtifactSha256V1,
  ownerAuthoritySigningBytesV1,
  publicKeySha256V1,
  verifyTrustedOwnerAuthorityV1,
} from "../scripts/runkit-contract/owner-authority-trust.mjs";

function signedAuthority(privateKey, overrides = {}) {
  const body = {
    schemaVersion: "TestOwnerAuthorityV1",
    authorityId: "owner-authority-001",
    scope: "test_exact_scope",
    signerKeyId: "owner-key-001",
    signatureAlgorithm: "ed25519",
    authorizationGranted: false,
    ...overrides,
  };
  return {
    ...body,
    authoritySha256: ownerAuthorityArtifactSha256V1(body),
    signature: sign(
      null,
      ownerAuthoritySigningBytesV1(body),
      privateKey,
    ).toString("base64"),
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-owner-trust-"));
  const trustStorePath = path.join(root, "owner-authority-trust-v1.json");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  await writeFile(trustStorePath, `${JSON.stringify({
    schemaVersion: "OwlCodaRunKitOwnerAuthorityTrustV1",
    keys: [{
      keyId: "owner-key-001",
      algorithm: "ed25519",
      publicKeyPem: publicKey.export({
        type: "spki",
        format: "pem",
      }),
      publicKeySha256: publicKeySha256V1(publicKey),
      purposes: ["test_authority"],
      status: "active",
    }],
  }, null, 2)}\n`, { mode: 0o600 });
  await chmod(trustStorePath, 0o600);
  return { root, trustStorePath, privateKey };
}

test("a fixed trusted Ed25519 key verifies an exact Owner authority payload", async () => {
  const value = await fixture();
  try {
    const authority = signedAuthority(value.privateKey);
    const verified = verifyTrustedOwnerAuthorityV1({
      authority,
      expectedScope: "test_exact_scope",
      expectedPurpose: "test_authority",
      trustStorePath: value.trustStorePath,
    });
    assert.equal(verified.status, "trusted");
    assert.equal(verified.signerKeyId, "owner-key-001");
    assert.equal(verified.authoritySha256, authority.authoritySha256);
    assert.match(verified.trustStoreSha256, /^sha256:[a-f0-9]{64}$/u);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("missing trust, unknown keys, payload tampering, and writable trust stores fail closed", async () => {
  const value = await fixture();
  try {
    const authority = signedAuthority(value.privateKey);
    assert.throws(
      () => verifyTrustedOwnerAuthorityV1({
        authority,
        expectedScope: "test_exact_scope",
        expectedPurpose: "test_authority",
        trustStorePath: path.join(value.root, "missing.json"),
      }),
      /owner_authority_trust_store_missing/u,
    );
    assert.throws(
      () => verifyTrustedOwnerAuthorityV1({
        authority: { ...authority, signerKeyId: "unknown-key" },
        expectedScope: "test_exact_scope",
        expectedPurpose: "test_authority",
        trustStorePath: value.trustStorePath,
      }),
      /owner_authority_signer_unknown/u,
    );
    assert.throws(
      () => verifyTrustedOwnerAuthorityV1({
        authority: { ...authority, scope: "tampered_scope" },
        expectedScope: "tampered_scope",
        expectedPurpose: "test_authority",
        trustStorePath: value.trustStorePath,
      }),
      /owner_authority_hash_mismatch/u,
    );
    if (process.platform !== "win32") {
      await chmod(value.trustStorePath, 0o622);
      assert.throws(
        () => verifyTrustedOwnerAuthorityV1({
          authority,
          expectedScope: "test_exact_scope",
          expectedPurpose: "test_authority",
          trustStorePath: value.trustStorePath,
        }),
        /owner_authority_trust_store_permissions_invalid/u,
      );
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("an authority signed by an untrusted private key cannot self-authorize", async () => {
  const value = await fixture();
  try {
    const attacker = generateKeyPairSync("ed25519");
    const authority = signedAuthority(attacker.privateKey);
    assert.throws(
      () => verifyTrustedOwnerAuthorityV1({
        authority,
        expectedScope: "test_exact_scope",
        expectedPurpose: "test_authority",
        trustStorePath: value.trustStorePath,
      }),
      /owner_authority_signature_invalid/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a symlinked or writable trust-store directory cannot become an authority root", async () => {
  const value = await fixture();
  const wrapper = await mkdtemp(path.join(tmpdir(), "owlrunkit-owner-trust-parent-"));
  try {
    const authority = signedAuthority(value.privateKey);
    const linkedParent = path.join(wrapper, "linked-trust");
    await symlink(value.root, linkedParent);
    assert.throws(
      () => verifyTrustedOwnerAuthorityV1({
        authority,
        expectedScope: "test_exact_scope",
        expectedPurpose: "test_authority",
        trustStorePath: path.join(linkedParent, "owner-authority-trust-v1.json"),
      }),
      /owner_authority_trust_store_path_invalid/u,
    );

    if (process.platform !== "win32") {
      await chmod(value.root, 0o722);
      assert.throws(
        () => verifyTrustedOwnerAuthorityV1({
          authority,
          expectedScope: "test_exact_scope",
          expectedPurpose: "test_authority",
          trustStorePath: value.trustStorePath,
        }),
        /owner_authority_trust_store_parent_permissions_invalid/u,
      );
    }
  } finally {
    await rm(wrapper, { recursive: true, force: true });
    await rm(value.root, { recursive: true, force: true });
  }
});
