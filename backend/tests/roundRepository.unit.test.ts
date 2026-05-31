import { test } from "node:test";
import assert from "node:assert";
import { RoundRepository } from "../src/repositories/roundRepository";
import { RoundState } from "../src/types/round";

const mockPrisma = {
  round: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      if (where.id !== "round-resolved") return null;
      return {
        id: "round-resolved",
        arenaId: "arena-1",
        roundNumber: 2,
        state: "RESOLVED",
        metadata: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      };
    },
    findMany: async (query: any) => {
      assert.strictEqual(query.where.arenaId, "arena-1");
      assert.strictEqual(query.take, 6);
      assert.strictEqual(query.skip, 25);
      return [
        {
          id: "round-26",
          arenaId: "arena-1",
          roundNumber: 26,
          state: "OPEN",
          metadata: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        {
          id: "round-27",
          arenaId: "arena-1",
          roundNumber: 27,
          state: "CLOSED",
          metadata: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        {
          id: "round-28",
          arenaId: "arena-1",
          roundNumber: 28,
          state: "RESOLVED",
          metadata: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ];
    },
  },
} as unknown as any;

const roundRepo = new RoundRepository(mockPrisma);

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString("base64url");
}

test("RoundRepository.findById returns actual state from the database", async () => {
  const round = await roundRepo.findById("round-resolved");
  assert.strictEqual(round?.state, RoundState.RESOLVED);
});

test("RoundRepository.listByArenaId honors opaque offset cursor and pagination", async () => {
  const cursor = encodeCursor(25);
  const result = await roundRepo.listByArenaId("arena-1", 5, cursor);

  assert.strictEqual(result.items.length, 3);
  const first = result.items[0];
  const second = result.items[1];
  const third = result.items[2];
  assert.ok(first && second && third);
  assert.strictEqual(first.roundNumber, 26);
  assert.strictEqual(second.roundNumber, 27);
  assert.strictEqual(third.state, RoundState.RESOLVED);
  assert.strictEqual(result.cursor, null);
  assert.strictEqual(result.hasMore, false);
});
