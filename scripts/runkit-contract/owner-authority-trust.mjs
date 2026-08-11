import {
  createHash,
  createPublicKey,
  verify,
} from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256_REF = /^sha256:[a-f0-9]{64}$/u;
const SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/u;
const MAX_TRUST_STORE_BYTES = 1_048_576;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("owner_authority_noncanonical_value");
  return encoded;
}

function sha256Ref(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function signingPayload(authority) {
  if (!authority || typeof authority !== "object" || Array.isArray(authority)) {
    throw new Error("owner_authority_invalid");
  }
  const {
    authoritySha256,
    signature,
    ...payload
  } = authority;
  return payload;
}

export function ownerAuthoritySigningBytesV1(authority) {
  return Buffer.from(canonicalJson(signingPayload(authority)), "utf8");
}

export function ownerAuthorityArtifactSha256V1(authority) {
  return sha256Ref(ownerAuthoritySigningBytesV1(authority));
}

export function publicKeySha256V1(publicKey) {
  const key = publicKey?.type === "public"
    ? publicKey
    : createPublicKey(publicKey);
  return sha256Ref(key.export({ type: "spki", format: "der" }));
}

export function defaultOwnerAuthorityTrustStorePathV1() {
  return path.join(
    userInfo().homedir,
    ".owlcoda",
    "trust",
    "owner-authority-keys-v1.json",
  );
}

function readTrustStore(trustStorePath) {
  const resolvedPath = path.resolve(trustStorePath);
  let stat;
  try {
    stat = lstatSync(resolvedPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("owner_authority_trust_store_missing");
    }
    throw error;
  }
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
  ) {
    throw new Error("owner_authority_trust_store_invalid");
  }
  realpathSync(resolvedPath);
  const parentPath = path.dirname(resolvedPath);
  const parentStat = lstatSync(parentPath);
  if (
    parentStat.isSymbolicLink()
    || !parentStat.isDirectory()
  ) {
    throw new Error("owner_authority_trust_store_path_invalid");
  }
  const currentUid = typeof process.getuid === "function"
    ? process.getuid()
    : null;
  if (
    currentUid !== null
    && (stat.uid !== currentUid || parentStat.uid !== currentUid)
  ) {
    throw new Error("owner_authority_trust_store_owner_invalid");
  }
  if (
    process.platform !== "win32"
    && (stat.mode & 0o022) !== 0
  ) {
    throw new Error("owner_authority_trust_store_permissions_invalid");
  }
  if (
    process.platform !== "win32"
    && (parentStat.mode & 0o022) !== 0
  ) {
    throw new Error("owner_authority_trust_store_parent_permissions_invalid");
  }
  if (stat.size <= 0 || stat.size > MAX_TRUST_STORE_BYTES) {
    throw new Error("owner_authority_trust_store_invalid");
  }
  const bytes = readFileSync(resolvedPath);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("owner_authority_trust_store_invalid");
  }
  if (
    value?.schemaVersion !== "OwlCodaRunKitOwnerAuthorityTrustV1"
    || !Array.isArray(value.keys)
    || value.keys.length === 0
  ) {
    throw new Error("owner_authority_trust_store_invalid");
  }
  const keyIds = new Set();
  const keys = value.keys.map((entry) => {
    if (
      !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || Object.keys(entry).sort().join(",")
        !== "algorithm,keyId,publicKeyPem,publicKeySha256,purposes,status"
      || !KEY_ID.test(entry.keyId)
      || entry.algorithm !== "ed25519"
      || typeof entry.publicKeyPem !== "string"
      || !SHA256_REF.test(entry.publicKeySha256)
      || !Array.isArray(entry.purposes)
      || entry.purposes.length === 0
      || entry.purposes.some(purpose => !KEY_ID.test(purpose))
      || new Set(entry.purposes).size !== entry.purposes.length
      || entry.status !== "active"
      || keyIds.has(entry.keyId)
    ) {
      throw new Error("owner_authority_trust_store_invalid");
    }
    keyIds.add(entry.keyId);
    let publicKey;
    try {
      publicKey = createPublicKey(entry.publicKeyPem);
    } catch {
      throw new Error("owner_authority_trust_store_invalid");
    }
    if (
      publicKey.asymmetricKeyType !== "ed25519"
      || publicKeySha256V1(publicKey) !== entry.publicKeySha256
    ) {
      throw new Error("owner_authority_trust_store_invalid");
    }
    return {
      keyId: entry.keyId,
      publicKey,
      purposes: [...entry.purposes],
    };
  });
  return {
    bytes,
    keys,
  };
}

export function verifyTrustedOwnerAuthorityV1({
  authority,
  expectedScope,
  expectedPurpose,
  trustStorePath = defaultOwnerAuthorityTrustStorePathV1(),
}) {
  if (
    !authority
    || typeof authority !== "object"
    || Array.isArray(authority)
    || !KEY_ID.test(authority.signerKeyId)
    || authority.signatureAlgorithm !== "ed25519"
    || typeof authority.signature !== "string"
    || !SIGNATURE.test(authority.signature)
    || !SHA256_REF.test(authority.authoritySha256)
    || typeof expectedScope !== "string"
    || expectedScope.length === 0
    || !KEY_ID.test(expectedPurpose)
  ) {
    throw new Error("owner_authority_invalid");
  }
  const trust = readTrustStore(path.resolve(trustStorePath));
  const selected = trust.keys.find(key => key.keyId === authority.signerKeyId);
  if (!selected) throw new Error("owner_authority_signer_unknown");
  if (!selected.purposes.includes(expectedPurpose)) {
    throw new Error("owner_authority_purpose_not_trusted");
  }
  const signingBytes = ownerAuthoritySigningBytesV1(authority);
  if (ownerAuthorityArtifactSha256V1(authority) !== authority.authoritySha256) {
    throw new Error("owner_authority_hash_mismatch");
  }
  if (authority.scope !== expectedScope) {
    throw new Error("owner_authority_scope_mismatch");
  }
  const signature = Buffer.from(authority.signature, "base64");
  if (
    signature.length === 0
    || signature.toString("base64") !== authority.signature
    || !verify(null, signingBytes, selected.publicKey, signature)
  ) {
    throw new Error("owner_authority_signature_invalid");
  }
  return {
    status: "trusted",
    signerKeyId: authority.signerKeyId,
    authoritySha256: authority.authoritySha256,
    trustStoreSha256: sha256Ref(trust.bytes),
  };
}
