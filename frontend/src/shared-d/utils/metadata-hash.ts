/**
 * Canonical arena metadata hashing (#1577).
 *
 * Spec (shared with `backend/src/utils/metadataHash.ts` and the Rust golden
 * vector test):
 *  - Serialize the metadata as UTF-8 JSON.
 *  - Object keys are sorted lexicographically at every level.
 *  - No insignificant whitespace (no spaces after `:` or `,`).
 *  - Array order is preserved.
 *  - `undefined` object values are omitted; `null` is preserved.
 *  - Hash the resulting UTF-8 bytes with SHA-256 and return lowercase hex.
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
      (key) =>
        `${JSON.stringify(key)}:${canonicalizeMetadata(record[key])}`,
    );
  return `{${entries.join(",")}}`;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Compute the on-chain `metadata_hash` for a metadata object. */
export async function hashMetadata(
  metadata: ArenaMetadataJson,
): Promise<string> {
  const canonical = canonicalizeMetadata(metadata);
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Compare a metadata document with the hash committed on-chain. Returns
 * `true` only when the canonical serialization hashes to the same value.
 */
export async function verifyMetadataHash(
  metadata: ArenaMetadataJson,
  onChainHash: string,
): Promise<boolean> {
  const computed = await hashMetadata(metadata);
  return computed.toLowerCase() === onChainHash.toLowerCase();
}
