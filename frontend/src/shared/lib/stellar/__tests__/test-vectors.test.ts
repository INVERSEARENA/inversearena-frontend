/**
 * Cross-language golden test vectors (#1643).
 *
 * Asserts every entry in `contract/test-vectors/commitment.json` against the
 * TypeScript implementations. The Rust suite
 * (`contract/arena/src/commitment_vectors.rs`) asserts the same file, so CI
 * fails when either side drifts.
 *
 * Regenerate with `BLESS_TEST_VECTORS=1 cargo test -p arena commitment_vectors`.
 * See `contract/test-vectors/README.md`.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeCommitment } from "../commit-reveal";
import { canonicalizeMetadata, hashMetadata } from "../metadata-hash";

// Jest is rooted at frontend/; the vectors live at the repo root under contract/.
const VECTORS_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "contract",
  "test-vectors",
  "commitment.json",
);

interface CommitmentVector {
  name: string;
  choice: "Heads" | "Tails";
  choiceByte: number;
  salt: string;
  context: { arena: number; round: number; player: string };
  preimage: string;
  commitment: string;
}

interface MetadataVector {
  name: string;
  metadata: Record<string, unknown>;
  canonical: string;
  hash: string;
}

interface AmountVector {
  name: string;
  decimal: string;
  i128: string | null;
  valid: boolean;
}

interface VectorFile {
  version: number;
  commitment: CommitmentVector[];
  metadataHash: MetadataVector[];
  amountEncoding: AmountVector[];
}

function loadVectors(): VectorFile {
  return JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as VectorFile;
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

describe("golden test vectors (#1643)", () => {
  const vectors = loadVectors();

  it("loads a versioned vector file with all three sections", () => {
    expect(vectors.version).toBe(1);
    expect(vectors.commitment.length).toBeGreaterThan(0);
    expect(vectors.metadataHash.length).toBeGreaterThan(0);
    expect(vectors.amountEncoding.length).toBeGreaterThan(0);
  });

  describe("commitment", () => {
    it("includes the required edge salts (all zero and all 0xff)", () => {
      const salts = vectors.commitment.map((v) => v.salt);
      expect(salts).toContain("00".repeat(32));
      expect(salts).toContain("ff".repeat(32));
    });

    it.each(vectors.commitment.map((v) => [v.name, v] as const))(
      "computeCommitment matches vector '%s'",
      async (_name, vector) => {
        const salt = hexToBytes(vector.salt);
        expect(salt.length).toBe(32);
        expect(vector.choiceByte).toBe(vector.choice === "Heads" ? 0 : 1);

        const expectedPreimage = Buffer.concat([
          Buffer.from([vector.choiceByte]),
          Buffer.from(salt),
        ]);
        expect(expectedPreimage.toString("hex")).toBe(vector.preimage);

        const expected = createHash("sha256").update(expectedPreimage).digest("hex");
        expect(expected).toBe(vector.commitment);

        const actual = await computeCommitment(vector.choice, salt);
        expect(bytesToHex(actual)).toBe(vector.commitment);
      },
    );
  });

  describe("metadataHash", () => {
    it.each(vectors.metadataHash.map((v) => [v.name, v] as const))(
      "canonical form and hash match vector '%s'",
      async (_name, vector) => {
        expect(canonicalizeMetadata(vector.metadata)).toBe(vector.canonical);
        await expect(hashMetadata(vector.metadata)).resolves.toBe(vector.hash);
      },
    );
  });

  describe("amountEncoding", () => {
    it.each(vectors.amountEncoding.map((v) => [v.name, v] as const))(
      "amount vector '%s' is accepted/rejected consistently",
      (_name, vector) => {
        const parsed = Number(vector.decimal);
        const isInteger = Number.isInteger(parsed) && Number.isFinite(parsed);

        if (vector.valid) {
          expect(vector.i128).not.toBeNull();
          expect(isInteger).toBe(true);
          expect(String(parsed)).toBe(vector.i128);
        } else {
          expect(vector.i128).toBeNull();
          expect(isInteger || parsed < 0).toBe(true);
        }
      },
    );
  });
});
