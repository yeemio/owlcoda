import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const skillRoot = process.env.OWLCODA_RUNKIT_SKILL_ROOT;
const foreignRoot = process.env.OWLCODA_RUNKIT_FOREIGN_ROOT;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(args) {
  const result = spawnSync("git", ["-C", foreignRoot, ...args], { encoding: null });
  assert.equal(result.status, 0, result.stderr?.toString("utf8"));
  return result.stdout;
}

test("installed Skill validates a foreign source packet with zero foreign repository writes", { skip: !skillRoot || !foreignRoot }, async () => {
  const selectedPath = "package.json";
  const selected = await readFile(path.join(foreignRoot, selectedPath));
  const files = { [selectedPath]: sha256(selected) };
  const canonical = `${selectedPath}\tsha256:${files[selectedPath]}\n`;
  const packet = {
    changedFiles: { wholeFileSha256: files },
    sourceFingerprint: { sha256: sha256(canonical) },
  };
  const controller = await mkdtemp(path.join(tmpdir(), "owlcoda-runkit-shadow-controller-"));
  try {
    const packetPath = path.join(controller, "delivery-packet.json");
    await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
    const before = {
      head: git(["rev-parse", "HEAD"]).toString("utf8").trim(),
      statusSha256: sha256(git(["status", "--porcelain=v1", "-z"])),
      selectedSha256: sha256(await readFile(path.join(foreignRoot, selectedPath))),
    };
    const result = spawnSync(process.execPath, [
      path.join(skillRoot, "scripts/source-fingerprint.mjs"),
      "--workspace", foreignRoot,
      "--packet", packetPath,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "valid");
    const after = {
      head: git(["rev-parse", "HEAD"]).toString("utf8").trim(),
      statusSha256: sha256(git(["status", "--porcelain=v1", "-z"])),
      selectedSha256: sha256(await readFile(path.join(foreignRoot, selectedPath))),
    };
    assert.deepEqual(after, before);
  } finally {
    await rm(controller, { recursive: true, force: true });
  }
});
