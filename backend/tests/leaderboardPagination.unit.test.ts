import { test } from "node:test";
import assert from "node:assert";
import type { Request, Response } from "express";
import { LeaderboardController } from "../src/controllers/leaderboard.controller";

/**
 * Leaderboard pagination is pushed into SQL (#1352).
 *
 * The CTE had no LIMIT/OFFSET: every cache miss aggregated a row for every user
 * with any yield or elimination history, materialised all of them as JS objects,
 * and then `slice()`d the requested window. Page 40 therefore cost exactly as
 * much as page 1, and the cost grew with the platform rather than the page.
 */

interface CapturedQuery {
  sql: string;
  values: unknown[];
}

function makeController(rowsFor: (limit: number, offset: number) => unknown[]) {
  const captured: CapturedQuery[] = [];

  const prisma = {
    // Prisma tagged-template call: (strings, ...values)
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      captured.push({ sql: strings.join("?"), values });
      const [limit, offset] = values as [number, number];
      return rowsFor(limit, offset);
    },
  } as any;

  return { controller: new LeaderboardController(prisma), captured };
}

function row(rank: number) {
  return {
    id: `user-${rank}`,
    walletAddress: `G${rank}`,
    totalYield: String(1000 - rank),
    arenasWon: "1",
    survivalStreak: "1",
    rank: String(rank),
  };
}

function makeReq(query: Record<string, string> = {}): Request {
  return { query } as unknown as Request;
}

function makeRes() {
  const res = {
    body: undefined as any,
    json(body: unknown) {
      this.body = body;
      return this;
    },
    status() {
      return this;
    },
  };
  return res as unknown as Response & { body: any };
}

test("the SQL query carries LIMIT and OFFSET", async () => {
  const { controller, captured } = makeController(() => []);

  await controller.getLeaderboard(makeReq({ limit: "10" }), makeRes());

  assert.strictEqual(captured.length, 1);
  assert.match(captured[0]!.sql, /LIMIT/i);
  assert.match(captured[0]!.sql, /OFFSET/i);
});

test("a deep page asks the database for that page, not the whole table", async () => {
  const { controller, captured } = makeController((limit, offset) =>
    Array.from({ length: limit }, (_, i) => row(offset + i + 1)),
  );

  // Page 5 at 20 per page → offset 80.
  const cursor = Buffer.from(JSON.stringify({ offset: 80 })).toString("base64url");
  await controller.getLeaderboard(makeReq({ limit: "20", cursor }), makeRes());

  const [limit, offset] = captured[0]!.values as [number, number];
  assert.strictEqual(offset, 80, "offset must reach SQL");
  // limit + 1 so hasMore is known without a second count query.
  assert.strictEqual(limit, 21);
});

test("only the requested page is returned to the caller", async () => {
  const { controller } = makeController((limit, offset) =>
    Array.from({ length: limit }, (_, i) => row(offset + i + 1)),
  );
  const res = makeRes();

  await controller.getLeaderboard(makeReq({ limit: "5" }), res);

  assert.strictEqual(res.body.players.length, 5, "the extra look-ahead row must not leak out");
  assert.ok(res.body.nextCursor, "a further page should be advertised");
});

test("rank comes from the database, so a deep page keeps global ranks", async () => {
  const { controller } = makeController((limit, offset) =>
    Array.from({ length: limit }, (_, i) => row(offset + i + 1)),
  );
  const res = makeRes();

  const cursor = Buffer.from(JSON.stringify({ offset: 80 })).toString("base64url");
  await controller.getLeaderboard(makeReq({ limit: "5", cursor }), res);

  // Deriving rank from the array index would restart at 1 on every page.
  assert.strictEqual(res.body.players[0].rank, 81);
  assert.strictEqual(res.body.players[4].rank, 85);
});

test("the last page reports no further cursor", async () => {
  // Fewer rows than the look-ahead asked for ⇒ this is the end.
  const { controller } = makeController(() => [row(1), row(2)]);
  const res = makeRes();

  await controller.getLeaderboard(makeReq({ limit: "5" }), res);

  assert.strictEqual(res.body.players.length, 2);
  assert.strictEqual(res.body.nextCursor, null);
});

test("an empty leaderboard returns an empty page", async () => {
  const { controller } = makeController(() => []);
  const res = makeRes();

  await controller.getLeaderboard(makeReq(), res);

  assert.deepStrictEqual(res.body.players, []);
  assert.strictEqual(res.body.nextCursor, null);
});

test("the database is queried exactly once per request", async () => {
  const { controller, captured } = makeController((limit) =>
    Array.from({ length: limit }, (_, i) => row(i + 1)),
  );

  await controller.getLeaderboard(makeReq({ limit: "10" }), makeRes());

  assert.strictEqual(captured.length, 1, "hasMore must not cost a second query");
});
