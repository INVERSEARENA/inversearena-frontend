/**
 * Join eligibility uses the on-chain `get_player_status` read for membership
 * and phase (#1582).
 *
 * Runs under `tsx --test` (node:test), not Jest: the service reads Arena
 * fields that ts-jest's type check rejects against the current Prisma schema.
 */
import { test } from "node:test";
import assert from "node:assert";
import type { PrismaClient } from "@prisma/client";
import { ParticipantEligibilityService } from "../src/services/participantEligibilityService";
import type { OnChainPlayerStatus, PlayerStatusReader } from "../src/services/playerStatus";
import { buildProvenance, unavailableRead, verifiedRead } from "../src/types/onChainRead";

const ARENA_ID = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
const WALLET = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

const prisma = {
  arena: {
    findUnique: async () => ({
      id: ARENA_ID,
      entryFee: 10,
      maxPlayers: 8,
      joinDeadline: null,
      stakeToken: "USDC",
    }),
  },
  round: { findFirst: async () => null },
} as unknown as PrismaClient;

const provenance = buildProvenance({
  functionName: "get_player_status",
  contractId: ARENA_ID,
  network: "test",
  ledgerSequence: 1,
});

function lobbyStatus(overrides: Partial<OnChainPlayerStatus> = {}): OnChainPlayerStatus {
  return {
    joined: false,
    active: false,
    committed: false,
    revealed: false,
    eliminatedRound: null,
    eliminationReason: "NotEliminated",
    refundClaimed: false,
    winner: false,
    currentRound: 0,
    phase: "Lobby",
    ...overrides,
  };
}

function check(reader: PlayerStatusReader) {
  return new ParticipantEligibilityService(prisma, reader).checkEligibility(
    ARENA_ID,
    WALLET,
    100,
    "USDC",
  );
}

function errorCodes(result: Awaited<ReturnType<typeof check>>): string[] {
  return result.errors.map((error) => error.code);
}

test("eligibility: a non-player in the lobby may join, read for the caller's wallet", async () => {
  const calls: Array<[string, string]> = [];
  const result = await check(async (contractId, player) => {
    calls.push([contractId, player]);
    return verifiedRead(lobbyStatus(), provenance);
  });

  assert.deepStrictEqual(calls, [[ARENA_ID, WALLET]]);
  assert.strictEqual(result.isEligible, true);
  assert.strictEqual(result.metadata.arenaPhase, "Lobby");
});

test("eligibility: a player who already joined is a duplicate", async () => {
  const result = await check(async () =>
    verifiedRead(lobbyStatus({ joined: true, active: true }), provenance),
  );
  assert.deepStrictEqual(errorCodes(result), ["DUPLICATE_MEMBERSHIP"]);
});

test("eligibility: joins are refused once the first round runs", async () => {
  const result = await check(async () =>
    verifiedRead(lobbyStatus({ phase: "Commit", currentRound: 1 }), provenance),
  );
  assert.deepStrictEqual(errorCodes(result), ["ARENA_NOT_JOINABLE"]);
  assert.strictEqual(result.metadata.arenaPhase, "Commit");
});

test("eligibility: an unreadable status fails closed", async () => {
  const result = await check(async () =>
    unavailableRead(provenance, "timeout", "simulation timed out"),
  );
  assert.strictEqual(result.isEligible, false);
  assert.deepStrictEqual(errorCodes(result), ["PLAYER_STATUS_UNAVAILABLE"]);
  assert.strictEqual(result.metadata.arenaPhase, "UNKNOWN");
});
