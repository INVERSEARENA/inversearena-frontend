/**
 * Tests for the commit-reveal client-side helpers (#1137).
 *
 * computeCommitment must match `contract/arena/src/lib.rs`'s
 * `compute_commitment` exactly: `SHA256([choice_byte] ++ salt_32_bytes)`,
 * with Heads=0 / Tails=1 (`Choice::to_byte`). Verified here against an
 * independent SHA-256 computation (Node's `crypto` module), not just
 * self-consistency.
 */
import { createHash } from "node:crypto";
import {
  generateSalt,
  computeCommitment,
  saveCommitment,
  loadCommitment,
  clearCommitment,
} from "../commit-reveal";

const PUBLIC_KEY = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

function independentSha256(preimage: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(Buffer.from(preimage)).digest());
}

describe("generateSalt", () => {
  it("returns exactly 32 bytes", () => {
    expect(generateSalt().length).toBe(32);
  });

  it("returns a different salt on each call", () => {
    const a = generateSalt();
    const b = generateSalt();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe("computeCommitment", () => {
  const salt = new Uint8Array(32).fill(42);

  it("matches an independent SHA-256([0] ++ salt) for Heads (byte 0)", async () => {
    const expected = independentSha256(new Uint8Array([0, ...salt]));
    const actual = await computeCommitment("Heads", salt);
    expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
  });

  it("matches an independent SHA-256([1] ++ salt) for Tails (byte 1)", async () => {
    const expected = independentSha256(new Uint8Array([1, ...salt]));
    const actual = await computeCommitment("Tails", salt);
    expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
  });

  it("produces a different commitment for a different salt", async () => {
    const otherSalt = new Uint8Array(32).fill(7);
    const a = await computeCommitment("Heads", salt);
    const b = await computeCommitment("Heads", otherSalt);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("produces a different commitment for a different choice with the same salt", async () => {
    const heads = await computeCommitment("Heads", salt);
    const tails = await computeCommitment("Tails", salt);
    expect(Buffer.from(heads).equals(Buffer.from(tails))).toBe(false);
  });

  it("throws when the salt is not exactly 32 bytes", async () => {
    await expect(computeCommitment("Heads", new Uint8Array(31))).rejects.toThrow(/32 bytes/);
    await expect(computeCommitment("Heads", new Uint8Array(33))).rejects.toThrow(/32 bytes/);
  });

  it("returns exactly 32 bytes (SHA-256 digest length)", async () => {
    const commitment = await computeCommitment("Heads", salt);
    expect(commitment.length).toBe(32);
  });
});

describe("saveCommitment / loadCommitment / clearCommitment", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips a saved commitment", () => {
    const salt = generateSalt();
    saveCommitment("arena-1", 3, PUBLIC_KEY, { choice: "Tails", salt });

    const loaded = loadCommitment("arena-1", 3, PUBLIC_KEY);

    expect(loaded).not.toBeNull();
    expect(loaded!.choice).toBe("Tails");
    expect(Buffer.from(loaded!.salt).equals(Buffer.from(salt))).toBe(true);
  });

  it("returns the saved commitment from the return value", () => {
    const salt = generateSalt();
    const result = saveCommitment("arena-1", 3, PUBLIC_KEY, { choice: "Heads", salt });
    expect(result.choice).toBe("Heads");
    expect(Buffer.from(result.salt).equals(Buffer.from(salt))).toBe(true);
  });

  it("is idempotent — a second call returns the first-saved commitment (#1492)", () => {
    const salt1 = generateSalt();
    const salt2 = generateSalt();
    saveCommitment("arena-1", 1, PUBLIC_KEY, { choice: "Heads", salt: salt1 });
    const result = saveCommitment("arena-1", 1, PUBLIC_KEY, { choice: "Tails", salt: salt2 });

    // The first commitment is preserved — the second write is a no-op.
    expect(result.choice).toBe("Heads");
    expect(Buffer.from(result.salt).equals(Buffer.from(salt1))).toBe(true);

    // loadCommitment also returns the original.
    const loaded = loadCommitment("arena-1", 1, PUBLIC_KEY);
    expect(loaded!.choice).toBe("Heads");
  });

  it("returns null when nothing was saved for that arena/round", () => {
    expect(loadCommitment("never-saved-arena", 1, PUBLIC_KEY)).toBeNull();
  });

  it("keys storage by both arena and round — no cross-contamination", () => {
    const saltA = generateSalt();
    const saltB = generateSalt();
    saveCommitment("arena-1", 1, PUBLIC_KEY, { choice: "Heads", salt: saltA });
    saveCommitment("arena-1", 2, PUBLIC_KEY, { choice: "Tails", salt: saltB });
    saveCommitment("arena-2", 1, PUBLIC_KEY, { choice: "Tails", salt: saltB });

    expect(loadCommitment("arena-1", 1, PUBLIC_KEY)!.choice).toBe("Heads");
    expect(loadCommitment("arena-1", 2, PUBLIC_KEY)!.choice).toBe("Tails");
    expect(loadCommitment("arena-2", 1, PUBLIC_KEY)!.choice).toBe("Tails");
  });

  it("clearCommitment removes only the targeted arena/round", () => {
    saveCommitment("arena-1", 1, PUBLIC_KEY, { choice: "Heads", salt: generateSalt() });
    saveCommitment("arena-1", 2, PUBLIC_KEY, { choice: "Tails", salt: generateSalt() });

    clearCommitment("arena-1", 1, PUBLIC_KEY);

    expect(loadCommitment("arena-1", 1, PUBLIC_KEY)).toBeNull();
    expect(loadCommitment("arena-1", 2, PUBLIC_KEY)).not.toBeNull();
  });

  it("returns null (not a throw) for corrupt stored JSON", () => {
    localStorage.setItem(`inversearena:commit-reveal:arena-1:5:${PUBLIC_KEY}`, "not json{{{");
    expect(loadCommitment("arena-1", 5, PUBLIC_KEY)).toBeNull();
  });

  it("returns null for a stored choice that isn't Heads/Tails", () => {
    localStorage.setItem(
      `inversearena:commit-reveal:arena-1:5:${PUBLIC_KEY}`,
      JSON.stringify({ choice: "Sideways", salt: "AAAA" }),
    );
    expect(loadCommitment("arena-1", 5, PUBLIC_KEY)).toBeNull();
  });
});
