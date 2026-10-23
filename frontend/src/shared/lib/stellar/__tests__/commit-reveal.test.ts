/**
 * Tests for the commit-reveal client-side helpers (#1137).
 *
 * computeCommitment must match `contract/arena/src/lib.rs`'s
 * `compute_commitment` exactly: `SHA256("IA_COMMIT_V1" || arena || round || player
 * || choice_byte || salt_32_bytes)` (#1630), with Heads=0 / Tails=1. Verified here against an
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

// Same arena/player the golden vector `heads-zero-salt` uses (contract/test-vectors).
const ARENA_ID = "CAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDB3V";
const OTHER_ARENA_ID = "CB3XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XOJMC";
const OTHER_PLAYER = "GARCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCFRVX";
// ScVal XDR of the arena contract address (SCV_ADDRESS, SC_ADDRESS_TYPE_CONTRACT)
// and of the all-zero account address, as Address::to_xdr produces in Rust.
const ARENA_XDR = Buffer.concat([
  Buffer.from("00000012", "hex"),
  Buffer.from("00000001", "hex"),
  Buffer.alloc(32, 0x11),
]);
const PLAYER_XDR = Buffer.concat([
  Buffer.from("00000012", "hex"),
  Buffer.from("00000000", "hex"),
  Buffer.from("00000000", "hex"),
  Buffer.alloc(32, 0x00),
]);

function independentSha256(preimage: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(Buffer.from(preimage)).digest());
}

/** Builds `"IA_COMMIT_V1" || arena || round || player || choice || salt` by hand. */
function boundPreimage(
  choiceByte: number,
  salt: Uint8Array,
  ctx: { round: number },
): Uint8Array {
  const round = Buffer.alloc(4);
  round.writeUInt32BE(ctx.round);
  return Buffer.concat([
    Buffer.from("IA_COMMIT_V1", "utf8"),
    ARENA_XDR,
    round,
    PLAYER_XDR,
    Buffer.from([choiceByte]),
    Buffer.from(salt),
  ]);
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
  const context = { arenaId: ARENA_ID, round: 1, player: PLAYER };

  it("matches an independent SHA-256 of the bound preimage for Heads (byte 0)", async () => {
    const expected = independentSha256(boundPreimage(0, salt, context));
    const actual = await computeCommitment("Heads", salt, context);
    expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
  });

  it("matches an independent SHA-256 of the bound preimage for Tails (byte 1)", async () => {
    const expected = independentSha256(boundPreimage(1, salt, context));
    const actual = await computeCommitment("Tails", salt, context);
    expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
  });

  it("produces a different commitment for a different salt", async () => {
    const otherSalt = new Uint8Array(32).fill(7);
    const a = await computeCommitment("Heads", salt, context);
    const b = await computeCommitment("Heads", otherSalt, context);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("produces a different commitment for a different choice with the same salt", async () => {
    const heads = await computeCommitment("Heads", salt, context);
    const tails = await computeCommitment("Tails", salt, context);
    expect(Buffer.from(heads).equals(Buffer.from(tails))).toBe(false);
  });

  it("binds the commitment to the player (#1630): a copied hash fails for another player", async () => {
    const mine = await computeCommitment("Heads", salt, context);
    const copier = await computeCommitment("Heads", salt, {
      ...context,
      player: OTHER_PLAYER,
    });
    expect(Buffer.from(mine).equals(Buffer.from(copier))).toBe(false);
  });

  it("binds the commitment to the round (#1630)", async () => {
    const round1 = await computeCommitment("Heads", salt, context);
    const round2 = await computeCommitment("Heads", salt, { ...context, round: 2 });
    expect(Buffer.from(round1).equals(Buffer.from(round2))).toBe(false);
  });

  it("binds the commitment to the arena (#1630)", async () => {
    const here = await computeCommitment("Heads", salt, context);
    const elsewhere = await computeCommitment("Heads", salt, {
      ...context,
      arenaId: OTHER_ARENA_ID,
    });
    expect(Buffer.from(here).equals(Buffer.from(elsewhere))).toBe(false);
  });

  it("throws when the salt is not exactly 32 bytes", async () => {
    await expect(computeCommitment("Heads", new Uint8Array(31), context)).rejects.toThrow(/32 bytes/);
    await expect(computeCommitment("Heads", new Uint8Array(33), context)).rejects.toThrow(/32 bytes/);
  });

  it("returns exactly 32 bytes (SHA-256 digest length)", async () => {
    const commitment = await computeCommitment("Heads", salt, context);
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
