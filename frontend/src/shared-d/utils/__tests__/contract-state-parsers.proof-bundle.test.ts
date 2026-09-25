/**
 * Tests for round outcome proof bundle verification (#1394).
 *
 * `recomputeSurvivorship` must faithfully reproduce the on-chain contract's
 * two elimination rules from `contract/arena/src/eliminations.rs` and
 * `contract/arena/src/lib.rs`'s `resolve_players`:
 *   1. Minority-wins tally rule (revealers only).
 *   2. AFK rule: any active player who did not reveal is eliminated
 *      unconditionally, independent of rule 1 and even on a tie.
 *
 * `verifyProofBundleChecksum` must reproduce the backend's
 * `roundProofBundleService.ts`'s `canonicalStringify` + SHA-256 exactly, so
 * this file also hand-rolls an independent copy of that backend logic (not
 * imported — frontend/backend are separate packages, see
 * `docs/round-outcome-proof-bundle.md`) and asserts the two agree, which is
 * the closest thing to a true cross-module integration test available
 * without a shared package boundary.
 */
import { createHash } from "node:crypto";
import type { RoundProofBundle } from "@/shared-d/types/contract-state";
import {
  assertProofBundleNetwork,
  computeSurvivingChoice,
  ProofBundleNetworkMismatchError,
  ProofBundleShapeError,
  recomputeSurvivorship,
  verifyProofBundleChecksum,
} from "../contract-state-parsers";

const NETWORK = {
  passphrase: "Test SDF Network ; September 2015",
  arenaContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
};

/**
 * Independent re-implementation of the backend's canonicalStringify +
 * SHA-256 checksum (see `backend/src/services/roundProofBundleService.ts`),
 * used ONLY to construct valid test fixtures with a correct checksum — this
 * intentionally duplicates backend logic rather than importing it, since
 * there is no shared package, and doing so lets the test independently
 * confirm the frontend's own canonicalStringify (used inside
 * verifyProofBundleChecksum) agrees byte-for-byte with this copy.
 */
function backendCanonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(backendCanonicalStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${backendCanonicalStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

function backendChecksum(bundleWithoutChecksum: Omit<RoundProofBundle, "checksum">): string {
  return createHash("sha256").update(backendCanonicalStringify(bundleWithoutChecksum)).digest("hex");
}

function buildBundle(overrides: Partial<RoundProofBundle> = {}): RoundProofBundle {
  const base: Omit<RoundProofBundle, "checksum"> = {
    version: 1,
    roundId: "round-1",
    arenaId: "arena-1",
    roundNumber: 4,
    network: NETWORK,
    playerChoices: [
      { userId: "p1", choice: "heads" },
      { userId: "p2", choice: "tails" },
      { userId: "p3", choice: "tails" },
    ],
    allActivePlayerIds: ["p1", "p2", "p3"],
    tally: { heads: 1, tails: 2 },
    eliminatedPlayers: ["p2", "p3"],
    survivors: ["p1"],
    generatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
  return { ...base, checksum: backendChecksum(base) };
}

describe("computeSurvivingChoice", () => {
  it("matches eliminations::surviving_choice's minority-wins rule", () => {
    expect(computeSurvivingChoice({ heads: 1, tails: 3 })).toBe("heads");
    expect(computeSurvivingChoice({ heads: 3, tails: 7 })).toBe("heads");
    expect(computeSurvivingChoice({ heads: 7, tails: 3 })).toBe("tails");
  });

  it("returns null on a strict tie (both sides nonzero and equal)", () => {
    expect(computeSurvivingChoice({ heads: 5, tails: 5 })).toBeNull();
  });

  it("returns null when there are no votes at all", () => {
    expect(computeSurvivingChoice({ heads: 0, tails: 0 })).toBeNull();
  });

  it("all-one-side survives when the other side has zero votes", () => {
    expect(computeSurvivingChoice({ heads: 10, tails: 0 })).toBe("heads");
    expect(computeSurvivingChoice({ heads: 0, tails: 10 })).toBe("tails");
  });

  it("boundary: a single submitter survives", () => {
    expect(computeSurvivingChoice({ heads: 1, tails: 0 })).toBe("heads");
  });
});

describe("recomputeSurvivorship — normal paths", () => {
  it("recomputes minority-wins elimination and agrees with the bundle's own claim", () => {
    const bundle = buildBundle();
    const result = recomputeSurvivorship(bundle);

    expect(result.survivingChoice).toBe("heads");
    expect(result.recomputedTally).toEqual({ heads: 1, tails: 2 });
    expect(result.recomputedEliminatedPlayers).toEqual(["p2", "p3"]);
    expect(result.recomputedSurvivors).toEqual(["p1"]);
    expect(result.nonRevealers).toEqual([]);
    expect(result.matchesBundleClaim).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  it("applies the AFK rule: a non-revealer in allActivePlayerIds but absent from playerChoices is eliminated unconditionally", () => {
    // p4 was active entering the round but never revealed.
    const bundle = buildBundle({
      playerChoices: [
        { userId: "p1", choice: "heads" },
        { userId: "p2", choice: "tails" },
      ],
      allActivePlayerIds: ["p1", "p2", "p4"],
      tally: { heads: 1, tails: 1 },
      eliminatedPlayers: ["p4"],
      survivors: ["p1", "p2"],
    });

    const result = recomputeSurvivorship(bundle);

    expect(result.survivingChoice).toBeNull(); // revealer tally is 1-1, a tie
    expect(result.nonRevealers).toEqual(["p4"]);
    // Tie means no revealer is eliminated by rule 1, but the AFK rule (rule 2)
    // still eliminates p4 regardless of the tie — this is the key subtlety
    // that distinguishes the two rules.
    expect(result.recomputedEliminatedPlayers).toEqual(["p4"]);
    expect(result.recomputedSurvivors).toEqual(["p1", "p2"]);
    expect(result.matchesBundleClaim).toBe(true);
  });

  it("AFK rule still applies when the revealer tally is NOT a tie", () => {
    // p1 heads, p2/p3 tails (tails is majority among revealers, eliminated),
    // p4 never revealed (eliminated regardless).
    const bundle = buildBundle({
      playerChoices: [
        { userId: "p1", choice: "heads" },
        { userId: "p2", choice: "tails" },
        { userId: "p3", choice: "tails" },
      ],
      allActivePlayerIds: ["p1", "p2", "p3", "p4"],
      tally: { heads: 1, tails: 2 },
      eliminatedPlayers: ["p2", "p3", "p4"],
      survivors: ["p1"],
    });

    const result = recomputeSurvivorship(bundle);
    expect(result.survivingChoice).toBe("heads");
    expect(result.nonRevealers).toEqual(["p4"]);
    expect(result.recomputedEliminatedPlayers).toEqual(["p2", "p3", "p4"]);
    expect(result.recomputedSurvivors).toEqual(["p1"]);
    expect(result.matchesBundleClaim).toBe(true);
  });
});

describe("recomputeSurvivorship — boundary paths", () => {
  it("a strict tie among revealers eliminates nobody (revealers all survive)", () => {
    const bundle = buildBundle({
      playerChoices: [
        { userId: "p1", choice: "heads" },
        { userId: "p2", choice: "tails" },
      ],
      allActivePlayerIds: ["p1", "p2"],
      tally: { heads: 1, tails: 1 },
      eliminatedPlayers: [],
      survivors: ["p1", "p2"],
    });

    const result = recomputeSurvivorship(bundle);
    expect(result.survivingChoice).toBeNull();
    expect(result.recomputedEliminatedPlayers).toEqual([]);
    expect(result.recomputedSurvivors).toEqual(["p1", "p2"]);
  });

  it("a single active player who revealed survives (no opposing votes)", () => {
    const bundle = buildBundle({
      playerChoices: [{ userId: "p1", choice: "heads" }],
      allActivePlayerIds: ["p1"],
      tally: { heads: 1, tails: 0 },
      eliminatedPlayers: [],
      survivors: ["p1"],
    });

    const result = recomputeSurvivorship(bundle);
    expect(result.recomputedSurvivors).toEqual(["p1"]);
    expect(result.recomputedEliminatedPlayers).toEqual([]);
  });

  it("everyone active but nobody revealed: all are eliminated by the AFK rule", () => {
    const bundle = buildBundle({
      playerChoices: [],
      allActivePlayerIds: ["p1", "p2"],
      tally: { heads: 0, tails: 0 },
      eliminatedPlayers: ["p1", "p2"],
      survivors: [],
    });

    const result = recomputeSurvivorship(bundle);
    expect(result.survivingChoice).toBeNull();
    expect(result.nonRevealers).toEqual(["p1", "p2"]);
    expect(result.recomputedEliminatedPlayers).toEqual(["p1", "p2"]);
    expect(result.recomputedSurvivors).toEqual([]);
  });

  it("maximum-size input: 500 active players recomputes without error", () => {
    const allActivePlayerIds = Array.from({ length: 500 }, (_, i) => `p${i}`);
    const playerChoices = allActivePlayerIds.map((userId, i) => ({
      userId,
      choice: (i % 3 === 0 ? "tails" : "heads") as "heads" | "tails",
    }));
    const heads = playerChoices.filter((c) => c.choice === "heads").length;
    const tails = playerChoices.filter((c) => c.choice === "tails").length;
    const survivingChoice = heads < tails ? "heads" : "tails";
    const eliminatedPlayers = playerChoices
      .filter((c) => c.choice !== survivingChoice)
      .map((c) => c.userId)
      .sort();
    const survivors = allActivePlayerIds.filter((id) => !eliminatedPlayers.includes(id)).sort();

    const bundle = buildBundle({
      playerChoices,
      allActivePlayerIds,
      tally: { heads, tails },
      eliminatedPlayers,
      survivors,
    });

    const result = recomputeSurvivorship(bundle);
    expect(result.matchesBundleClaim).toBe(true);
    expect(result.recomputedEliminatedPlayers).toHaveLength(eliminatedPlayers.length);
  });
});

describe("recomputeSurvivorship — mismatch detection (backend claim disagrees with recomputation)", () => {
  it("flags a mismatch when the bundle's claimed eliminatedPlayers disagrees with the true minority-wins outcome", () => {
    // Tampered: backend/attacker claims p1 (the true minority/survivor) was eliminated instead of p2/p3.
    const bundle = buildBundle({ eliminatedPlayers: ["p1"], survivors: ["p2", "p3"] });

    const result = recomputeSurvivorship(bundle);
    expect(result.matchesBundleClaim).toBe(false);
    expect(result.mismatches.some((m) => m.startsWith("eliminatedPlayers"))).toBe(true);
    expect(result.mismatches.some((m) => m.startsWith("survivors"))).toBe(true);
    // The recomputed (trustworthy) answer is unaffected by the tampered claim.
    expect(result.recomputedEliminatedPlayers).toEqual(["p2", "p3"]);
  });

  it("flags a mismatch when the bundle's claimed tally disagrees with playerChoices", () => {
    const bundle = buildBundle({ tally: { heads: 2, tails: 1 } });

    const result = recomputeSurvivorship(bundle);
    expect(result.matchesBundleClaim).toBe(false);
    expect(result.mismatches.some((m) => m.startsWith("tally"))).toBe(true);
  });
});

describe("recomputeSurvivorship — invalid input paths", () => {
  it("throws ProofBundleShapeError for an unrecognized version", () => {
    const bundle = buildBundle({ version: 2 as 1 });
    expect(() => recomputeSurvivorship(bundle)).toThrow(ProofBundleShapeError);
  });

  it("throws ProofBundleShapeError when allActivePlayerIds is empty", () => {
    const bundle = buildBundle({ allActivePlayerIds: [] });
    expect(() => recomputeSurvivorship(bundle)).toThrow(ProofBundleShapeError);
  });

  it("throws ProofBundleShapeError when playerChoices references a userId not in allActivePlayerIds", () => {
    const bundle = buildBundle({
      playerChoices: [
        { userId: "p1", choice: "heads" },
        { userId: "ghost", choice: "tails" },
      ],
      allActivePlayerIds: ["p1", "p2", "p3"],
    });
    expect(() => recomputeSurvivorship(bundle)).toThrow(ProofBundleShapeError);
  });

  it("throws ProofBundleShapeError on a duplicate playerChoices entry for the same userId", () => {
    const bundle = buildBundle({
      playerChoices: [
        { userId: "p1", choice: "heads" },
        { userId: "p1", choice: "tails" },
      ],
      allActivePlayerIds: ["p1", "p2", "p3"],
    });
    expect(() => recomputeSurvivorship(bundle)).toThrow(ProofBundleShapeError);
  });

  it("throws ProofBundleShapeError on duplicate ids within allActivePlayerIds", () => {
    const bundle = buildBundle({ allActivePlayerIds: ["p1", "p1", "p2", "p3"] });
    expect(() => recomputeSurvivorship(bundle)).toThrow(ProofBundleShapeError);
  });

  it("throws ProofBundleShapeError on an invalid choice value", () => {
    const bundle = buildBundle({
      playerChoices: [{ userId: "p1", choice: "sideways" as "heads" }],
      allActivePlayerIds: ["p1"],
    });
    expect(() => recomputeSurvivorship(bundle)).toThrow(ProofBundleShapeError);
  });
});

describe("assertProofBundleNetwork", () => {
  it("does not throw when the bundle's network matches the expected network", () => {
    const bundle = buildBundle();
    expect(() => assertProofBundleNetwork(bundle, NETWORK)).not.toThrow();
  });

  it("throws ProofBundleNetworkMismatchError for a testnet bundle checked against mainnet", () => {
    const bundle = buildBundle();
    const mainnet = { passphrase: "Public Global Stellar Network ; September 2015", arenaContractId: NETWORK.arenaContractId };
    expect(() => assertProofBundleNetwork(bundle, mainnet)).toThrow(ProofBundleNetworkMismatchError);
  });

  it("throws when the passphrase matches but the arena contract id differs", () => {
    const bundle = buildBundle();
    const otherArena = { ...NETWORK, arenaContractId: "CZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZD2KM" };
    expect(() => assertProofBundleNetwork(bundle, otherArena)).toThrow(ProofBundleNetworkMismatchError);
  });
});

describe("verifyProofBundleChecksum", () => {
  it("returns true for a bundle whose checksum was computed the same way the backend computes it", async () => {
    const bundle = buildBundle();
    await expect(verifyProofBundleChecksum(bundle)).resolves.toBe(true);
  });

  it("cross-module integration check: the frontend's canonical JSON form agrees byte-for-byte with an independent re-implementation of the backend's canonicalStringify", async () => {
    const bundle = buildBundle();
    const { checksum, ...rest } = bundle;
    const independentChecksum = backendChecksum(rest);
    expect(checksum).toBe(independentChecksum);
    await expect(verifyProofBundleChecksum(bundle)).resolves.toBe(true);
  });

  it("returns false when any field was tampered with after the checksum was computed (invalid input / integrity failure)", async () => {
    const bundle = buildBundle();
    const tampered: RoundProofBundle = { ...bundle, survivors: ["p1", "p2"] };
    await expect(verifyProofBundleChecksum(tampered)).resolves.toBe(false);
  });

  it("returns false for a checksum that is simply wrong", async () => {
    const bundle = buildBundle({ checksum: "0".repeat(64) } as Partial<RoundProofBundle>);
    await expect(verifyProofBundleChecksum(bundle)).resolves.toBe(false);
  });

  it("is insensitive to object key order (canonical form sorts keys)", async () => {
    const bundle = buildBundle();
    // Re-create the object with keys inserted in a different order; the
    // resulting JS object is structurally identical, so the checksum should
    // still verify — this specifically exercises canonicalStringify's key
    // sort, not just re-serialization stability.
    const reordered: RoundProofBundle = {
      checksum: bundle.checksum,
      generatedAt: bundle.generatedAt,
      survivors: bundle.survivors,
      eliminatedPlayers: bundle.eliminatedPlayers,
      tally: bundle.tally,
      allActivePlayerIds: bundle.allActivePlayerIds,
      playerChoices: bundle.playerChoices,
      network: bundle.network,
      roundNumber: bundle.roundNumber,
      arenaId: bundle.arenaId,
      roundId: bundle.roundId,
      version: bundle.version,
    };
    await expect(verifyProofBundleChecksum(reordered)).resolves.toBe(true);
  });
});

describe("recomputeSurvivorship + verifyProofBundleChecksum — combined cross-module flow", () => {
  it("a bundle that passes checksum verification and shape validation also agrees on survivorship (the full client trust flow)", async () => {
    const bundle = buildBundle();

    assertProofBundleNetwork(bundle, NETWORK);
    const checksumOk = await verifyProofBundleChecksum(bundle);
    const recomputation = recomputeSurvivorship(bundle);

    expect(checksumOk).toBe(true);
    expect(recomputation.matchesBundleClaim).toBe(true);
    expect(recomputation.recomputedSurvivors).toEqual(bundle.survivors);
  });

  it("a bundle with a tampered survivors claim fails survivorship agreement even though checksum verification runs independently", async () => {
    // Simulate an attacker who tampers with `survivors` AND recomputes a
    // matching checksum over the tampered bundle (i.e. a fully self-consistent
    // but factually wrong bundle) — checksum verification alone cannot catch
    // this, which is exactly why recomputeSurvivorship must never be skipped.
    const bundle = buildBundle({ eliminatedPlayers: ["p1"], survivors: ["p2", "p3"] });

    const checksumOk = await verifyProofBundleChecksum(bundle);
    const recomputation = recomputeSurvivorship(bundle);

    expect(checksumOk).toBe(true); // checksum is internally consistent with the (tampered) claim
    expect(recomputation.matchesBundleClaim).toBe(false); // but the claim itself is wrong
  });
});
