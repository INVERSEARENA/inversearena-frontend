import { createHash } from "crypto";

/**
 * Canonical arena metadata hashing (#1577).
 *
 * Spec (shared with `frontend/src/shared-d/utils/metadata-hash.ts` and the Rust
 * golden vector test):
 *  - UTF-8 JSON, object keys sorted lexicographically at every level.
 *  - No insignificant whitespace (no spaces after `:` or `,`).
 *  - Array order preserved; `undefined` values omitted; `null` preserved.
 *  - SHA-256 over the canonical UTF-8 bytes, returned as lowercase hex.
 */

export type ArenaMetadataJson = Record<string, unknown>;

export function canonicalizeMetadata(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeMetadata(entry)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalizeMetadata(record[key])}`,
    );
  return `{${entries.join(",")}}`;
}

export function hashMetadata(metadata: ArenaMetadataJson): string {
  return createHash("sha256")
    .update(canonicalizeMetadata(metadata), "utf8")
    .digest("hex");
}

export function verifyMetadataHash(
  metadata: ArenaMetadataJson,
  onChainHash: string,
): boolean {
  return hashMetadata(metadata) === onChainHash.toLowerCase();
}
