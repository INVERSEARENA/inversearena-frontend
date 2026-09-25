/**
 * Unit coverage for the player activity feed's keyset pagination (#1403):
 * normal listing, boundary (last page), gap-free behavior under a
 * concurrent insert between two page requests, and invalid-cursor recovery.
 */
import { PlayerActivityService } from "../src/services/playerActivityService";

const WALLET = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

interface Row {
  id: string;
  userId: string;
  roundId: string;
  reason: string | null;
  eliminatedAt: Date;
  round: { arenaId: string; roundNumber: number };
}

/**
 * A minimal in-memory stand-in for prisma.eliminationLog that implements
 * exactly the where/orderBy/take semantics the service issues, so these
 * tests exercise the real keyset-cursor arithmetic rather than mocking
 * "findMany was called with some object".
 */
function makeFakePrisma(rows: Row[]) {
  return {
    eliminationLog: {
      findMany: async (args: any) => {
        let filtered = rows.filter((r) => r.userId === args.where.userId);

        const or = args.where.OR as
          | [{ eliminatedAt: { lt: Date } }, { eliminatedAt: Date; id: { lt: string } }]
          | undefined;
        if (or) {
          const [beforeTime, sameTimeEarlierId] = or;
          filtered = filtered.filter(
            (r) =>
              r.eliminatedAt.getTime() < beforeTime.eliminatedAt.lt.getTime() ||
              (r.eliminatedAt.getTime() === sameTimeEarlierId.eliminatedAt.getTime() &&
                r.id < sameTimeEarlierId.id.lt),
          );
        }

        filtered.sort((a, b) => {
          const t = b.eliminatedAt.getTime() - a.eliminatedAt.getTime();
          if (t !== 0) return t;
          return b.id.localeCompare(a.id);
        });

        return filtered.slice(0, args.take);
      },
    },
  } as any;
}

function row(id: string, eliminatedAt: string, arenaId = "arena-1", roundNumber = 1): Row {
  return {
    id,
    userId: WALLET,
    roundId: `round-${roundNumber}`,
    reason: "ELIMINATED_BY_ROUND",
    eliminatedAt: new Date(eliminatedAt),
    round: { arenaId, roundNumber },
  };
}

describe("PlayerActivityService.getActivityFeed", () => {
  it("returns the newest page first with hasMore true when more rows exist", async () => {
    const rows = [
      row("e5", "2026-01-05T00:00:00.000Z"),
      row("e4", "2026-01-04T00:00:00.000Z"),
      row("e3", "2026-01-03T00:00:00.000Z"),
      row("e2", "2026-01-02T00:00:00.000Z"),
      row("e1", "2026-01-01T00:00:00.000Z"),
    ];
    const service = new PlayerActivityService(makeFakePrisma(rows));

    const page = await service.getActivityFeed(WALLET, 2);

    expect(page.items.map((i) => i.id)).toEqual(["e5", "e4"]);
    expect(page.hasMore).toBe(true);
    expect(page.cursor).not.toBeNull();
  });

  it("the cursor from page one continues into page two with no overlap or gap", async () => {
    const rows = [
      row("e5", "2026-01-05T00:00:00.000Z"),
      row("e4", "2026-01-04T00:00:00.000Z"),
      row("e3", "2026-01-03T00:00:00.000Z"),
      row("e2", "2026-01-02T00:00:00.000Z"),
      row("e1", "2026-01-01T00:00:00.000Z"),
    ];
    const service = new PlayerActivityService(makeFakePrisma(rows));

    const page1 = await service.getActivityFeed(WALLET, 2);
    const page2 = await service.getActivityFeed(WALLET, 2, page1.cursor!);

    expect(page2.items.map((i) => i.id)).toEqual(["e3", "e2"]);
  });

  it("reaches the last page with hasMore:false and cursor:null", async () => {
    const rows = [
      row("e2", "2026-01-02T00:00:00.000Z"),
      row("e1", "2026-01-01T00:00:00.000Z"),
    ];
    const service = new PlayerActivityService(makeFakePrisma(rows));

    const page = await service.getActivityFeed(WALLET, 5);

    expect(page.items.map((i) => i.id)).toEqual(["e2", "e1"]);
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBeNull();
  });

  it("does not skip or duplicate an already-seen row when a new event is inserted between two page fetches (#1403)", async () => {
    const rows = [
      row("e5", "2026-01-05T00:00:00.000Z"),
      row("e4", "2026-01-04T00:00:00.000Z"),
      row("e3", "2026-01-03T00:00:00.000Z"),
      row("e2", "2026-01-02T00:00:00.000Z"),
      row("e1", "2026-01-01T00:00:00.000Z"),
    ];
    const service = new PlayerActivityService(makeFakePrisma(rows));

    const page1 = await service.getActivityFeed(WALLET, 2);
    expect(page1.items.map((i) => i.id)).toEqual(["e5", "e4"]);

    // A new elimination lands between the two requests, newer than
    // everything the caller has already seen.
    rows.unshift(row("e6", "2026-01-06T00:00:00.000Z"));

    const page2 = await service.getActivityFeed(WALLET, 2, page1.cursor!);

    // Page 2 must continue exactly where page 1 left off: e3, e2 — not
    // re-include e4 (would happen with an offset-based cursor once a new
    // row shifted everyone's index) and not skip e3.
    expect(page2.items.map((i) => i.id)).toEqual(["e3", "e2"]);
  });

  it("also has no gap when the inserted event's timestamp ties the cursor row's timestamp", async () => {
    const rows = [
      row("e3", "2026-01-02T00:00:00.000Z"),
      row("e2", "2026-01-01T00:00:00.000Z"),
      row("e1", "2026-01-01T00:00:00.000Z"), // same instant as e2
    ];
    const service = new PlayerActivityService(makeFakePrisma(rows));

    const page1 = await service.getActivityFeed(WALLET, 1);
    expect(page1.items.map((i) => i.id)).toEqual(["e3"]);

    const page2 = await service.getActivityFeed(WALLET, 1, page1.cursor!);
    expect(page2.items.map((i) => i.id)).toEqual(["e2"]);

    const page3 = await service.getActivityFeed(WALLET, 1, page2.cursor!);
    expect(page3.items.map((i) => i.id)).toEqual(["e1"]);
    expect(page3.hasMore).toBe(false);
  });

  it("scopes strictly to the requested wallet, never another wallet's eliminations", async () => {
    const otherWallet = "GOTHER00000000000000000000000000000000000000000000000";
    const rows = [
      row("mine", "2026-01-02T00:00:00.000Z"),
      { ...row("theirs", "2026-01-01T00:00:00.000Z"), userId: otherWallet },
    ];
    const service = new PlayerActivityService(makeFakePrisma(rows));

    const page = await service.getActivityFeed(WALLET, 10);

    expect(page.items.map((i) => i.id)).toEqual(["mine"]);
  });

  it("returns an empty page for a wallet with no eliminations, not an error", async () => {
    const service = new PlayerActivityService(makeFakePrisma([]));

    const page = await service.getActivityFeed(WALLET, 10);

    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBeNull();
  });

  it("recovers to the first page on a malformed cursor instead of throwing", async () => {
    const rows = [row("e1", "2026-01-01T00:00:00.000Z")];
    const service = new PlayerActivityService(makeFakePrisma(rows));

    const page = await service.getActivityFeed(WALLET, 10, "not-valid-base64url-json");

    expect(page.items.map((i) => i.id)).toEqual(["e1"]);
  });

  it("recovers to the first page when the cursor decodes but has the wrong shape", async () => {
    const rows = [row("e1", "2026-01-01T00:00:00.000Z")];
    const service = new PlayerActivityService(makeFakePrisma(rows));

    const badCursor = Buffer.from(JSON.stringify({ foo: "bar" })).toString("base64url");
    const page = await service.getActivityFeed(WALLET, 10, badCursor);

    expect(page.items.map((i) => i.id)).toEqual(["e1"]);
  });

  it("includes arenaId, roundNumber, and reason from the joined round", async () => {
    const rows = [row("e1", "2026-01-01T00:00:00.000Z", "arena-42", 7)];
    const service = new PlayerActivityService(makeFakePrisma(rows));

    const page = await service.getActivityFeed(WALLET, 10);

    expect(page.items[0]).toMatchObject({
      id: "e1",
      type: "player_eliminated",
      arenaId: "arena-42",
      roundNumber: 7,
      reason: "ELIMINATED_BY_ROUND",
    });
  });
});
