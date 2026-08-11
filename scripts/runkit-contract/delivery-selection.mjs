import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function candidatePath(candidate) {
  const value = candidate?.packetPath ?? candidate?.path;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Delivery candidate requires packetPath or path.");
  }
  return value;
}

export function collapseByteIdenticalDeliveryCandidates(candidates) {
  const groups = new Map();
  for (const candidate of [...candidates].sort((left, right) =>
    candidatePath(left).localeCompare(candidatePath(right)))) {
    const digest = createHash("sha256")
      .update(readFileSync(candidatePath(candidate)))
      .digest("hex");
    const existing = groups.get(digest);
    if (existing) {
      existing.duplicatePacketPaths.push(candidatePath(candidate));
      continue;
    }
    groups.set(digest, {
      ...candidate,
      packetFileSha256: digest,
      duplicatePacketPaths: [],
    });
  }
  return [...groups.values()];
}
