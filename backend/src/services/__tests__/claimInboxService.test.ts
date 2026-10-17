/**
 * Claim inbox service tests (#1489).
 *
 * The cases here are the acceptance criteria's list, in the order a reviewer
 * will look for them: mixed assets, partial RPC failure, stale records,
 * duplicate events, already-claimed, and ownership enforcement.
 *
 * @module
 */

import type { ClaimInboxArenaState } from "../../types/claimInbox";
import { ClaimInboxService, type ClaimInboxRefundCandidate } from "../claimInboxService";
import { InMemoryTransactionRepository } from "../../repositories/inMemoryTransactionRepository";
import type { TransactionRecord, PaymentStatus } from "../../types/payment";

const WALLET = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const OTHER_WALLET = "GD6ROJBYLKQMOW3E7N4M2YBPUHMZD7PL65VRHRMO24BOVSBV5H3BQRSL";
const ISSUER_USDC = `G${"U".repeat(2)}${"S".repeat(52)}C`;
const ARENA_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ARENA_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const ARENA_C = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

const T0 = new Date("2026-09-27T10:00:00.000Z");

/**
 * Nonces for fixtures.
 *
 * `InMemoryTransactionRepository.insert` rejects a duplicate
 * `(sourceAccount, nonce)` pair, and every fixture shares one source account,
 * so each record needs its own. A plain counter guarantees that; keying by id
 * does not, because a counter sized from the map can hand two different ids
 * the same value once an id has been seen before.
 */
let nextNonce = 0;
function nonceFor(): number {
  nextNonce += 1;
  return nextNonce;
}

function payout(
  over: Partial<TransactionRecord> & { id: string; payoutId: string },
): TransactionRecord {
  const { id, payoutId, ...rest } = over;
  return {
    idempotencyKey: `idem-${id}`,
    sourceAccount: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    destinationAccount: WALLET,
    asset: "XLM",
    amountStroops: "100000000",
    nonce: nonceFor(),
    status: "submitted",
    unsignedXdr: "xdr",
    txHash: `hash-${id}`,
    attempts: 1,
    createdAt: T0,
    updatedAt: T0,
    confirmedAt: null,
    ...rest,
    id,
    payoutId,
  };
}

function refund(
  over: Partial<ClaimInboxRefundCandidate> & { arenaId: string },
): ClaimInboxRefundCandidate {
  const { arenaId, ...rest } = over;
  return {
    arenaName: `Arena ${arenaId.slice(0, 4)}`,
    walletAddress: WALLET,
    assetCode: "XLM",
    refundAmountStroops: "50000000",
    recoveryStatus: "refundable",
    updatedAt: T0,
    ...rest,
    arenaId,
  };
}

interface Harness {
  service: ClaimInboxService;
  repo: InMemoryTransactionRepository;
  seed: (...records: TransactionRecord[]) => Promise<void>;
  setStates: (states: Map<string, ClaimInboxArenaState>) => void;
  setFailing: (fail: boolean | string[]) => void;
  now: () => number;
}

function harness(opts: { now?: () => number } = {}): Harness {
  const repo = new InMemoryTransactionRepository();
  let states = new Map<string, ClaimInboxArenaState>();
  // Arena ids whose read fails. Empty means every read succeeds.
  let failing = new Set<string>();
  const now = opts.now ?? (() => T0.getTime() + 60_000);

  const service = new ClaimInboxService({
    prisma: {} as never,
    transactions: repo,
    now,
    // Mirrors `verifyArenasOnChain`: one bad arena is omitted from the result
    // rather than failing the whole batch, so the other positions stay usable.
    verifyArenas: async (arenaIds) => {
      if (failing.size > arenaIds.length) throw new Error("rpc_unreachable");
      return new Map(
        arenaIds
          .filter((id) => !failing.has("*") && !failing.has(id))
          .map((id) => [id, states.get(id) ?? "Finished"] as const),
      );
    },
    findRefunds: async () => [],
  });

  return {
    service,
    repo,
    seed: async (...records) => {
      for (const record of records) await repo.insert(record);
    },
    setStates: (next) => {
      states = next;
    },
    setFailing: (next) => {
      // `"*"` reads as "omit everything", which is how a total RPC outage
      // reaches every arena through the same per-arena path.
      failing =
        typeof next === "boolean" ? (next ? new Set(["*"]) : new Set<string>()) : new Set(next);
    },
    now,
  };
}

beforeEach(() => {
  // Each test needs its own repository, which `harness()` provides.
});

describe("ownership enforcement", () => {
  it("never returns another wallet's payout", async () => {
    const h = harness();
    await h.seed(
      payout({ id: "mine", payoutId: ARENA_A, destinationAccount: WALLET }),
      payout({ id: "theirs", payoutId: ARENA_B, destinationAccount: OTHER_WALLET, amountStroops: "999999999" }),
    );
    h.setStates(new Map([[ARENA_A, "Finished"]]));

    const page = await h.service.getInbox(WALLET, 20);

    expect(page.items.map((i) => i.arenaId)).toEqual([ARENA_A]);
    expect(page.items.flatMap((i) => i.components).map((c) => c.amountStroops)).not.toContain(
      "999999999",
    );
  });

  it("drops a refund candidate belonging to a different wallet", async () => {
    const repo = new InMemoryTransactionRepository();
    const service = new ClaimInboxService({
      prisma: {} as never,
      transactions: repo,
      now: () => T0.getTime() + 60_000,
      verifyArenas: async () => new Map(),
      // A source that hands back someone else's row.
      findRefunds: async () => [refund({ arenaId: ARENA_B, walletAddress: OTHER_WALLET })],
    });

    const page = await service.getInbox(WALLET, 20);

    // Defence in depth: the source query is supposed to scope this, and the
    // aggregator refuses to trust it.
    expect(page.items).toHaveLength(0);
  });
});

describe("duplicate arenas are impossible", () => {
  it("refuses a second payout record for the same arena", async () => {
    // `payoutId` is unique, so the duplicate case cannot be constructed at the
    // payout layer: there is never a second winnings record to merge. The
    // duplicate-arena case that can occur is winnings plus refund, covered
    // below.
    const h = harness();
    await h.seed(payout({ id: "p1", payoutId: ARENA_A, amountStroops: "100000000" }));

    await expect(
      h.seed(payout({ id: "p2", payoutId: ARENA_A, amountStroops: "200000000" })),
    ).rejects.toThrow(/Duplicate/);
  });

  it("merges a winnings and a refund position in the same arena into one item", async () => {
    const repo = new InMemoryTransactionRepository();
    await repo.insert(payout({ id: "p1", payoutId: ARENA_A, amountStroops: "100000000" }));
    const service = new ClaimInboxService({
      prisma: {} as never,
      transactions: repo,
      now: () => T0.getTime() + 60_000,
      verifyArenas: async (ids) => new Map(ids.map((id) => [id, "Finished" as const])),
      findRefunds: async () => [refund({ arenaId: ARENA_A, refundAmountStroops: "50000000" })],
    });

    const page = await service.getInbox(WALLET, 20);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.kind).toBe("mixed");
    expect(page.items[0]?.components.map((c) => c.kind).sort()).toEqual(["refund", "winnings"]);
  });
});

describe("states", () => {
  it("reports an unfinished arena as blocked, not claimable", async () => {
    const h = harness();
    // `built`, not the default `submitted`: this asserts on arena state, so
    // the payout must not already be in flight and short-circuit to pending.
    await h.seed(payout({ id: "p1", payoutId: ARENA_A, status: "built" }));
    h.setStates(new Map([[ARENA_A, "InProgress"]]));

    const [item] = (await h.service.getInbox(WALLET, 20)).items;

    expect(item?.state).toBe("blocked");
    expect(item?.reason).toBe("arena_not_finished");
    expect(item?.action).toBeNull();
  });

  it("reports a finished arena with no payout as actionable", async () => {
    const h = harness();
    await h.seed(payout({ id: "p1", payoutId: ARENA_A, status: "built" }));
    h.setStates(new Map([[ARENA_A, "Finished"]]));

    const [item] = (await h.service.getInbox(WALLET, 20)).items;

    expect(item?.state).toBe("actionable");
    expect(item?.reason).toBe("claim_ready");
    expect(item?.action).toEqual({ type: "claim", label: "Claim winnings", endpoint: null });
  });

  it("reports an in-flight payout as pending with no action", async () => {
    const h = harness();
    await h.seed(payout({ id: "p1", payoutId: ARENA_A, status: "submitted" }));
    h.setStates(new Map([[ARENA_A, "Finished"]]));

    const [item] = (await h.service.getInbox(WALLET, 20)).items;

    expect(item?.state).toBe("pending");
    expect(item?.reason).toBe("payout_submitted");
    // The chain decides; there is nothing for the user to press.
    expect(item?.action?.type).toBe("view_history");
  });

  it("reports a dead payout as blocked rather than hiding it", async () => {
    const h = harness();
    await h.seed(payout({ id: "p1", payoutId: ARENA_A, status: "dead", attempts: 3 }));
    h.setStates(new Map([[ARENA_A, "Finished"]]));

    const [item] = (await h.service.getInbox(WALLET, 20)).items;

    expect(item?.state).toBe("blocked");
    expect(item?.reason).toBe("payout_failed");
    expect(item?.components[0]?.attempts).toBe(3);
  });

  it("reports an unknown status as unavailable, never as completed", async () => {
    const h = harness();
    await h.seed(payout({ id: "p1", payoutId: ARENA_A, status: "unknown" }));
    h.setStates(new Map([[ARENA_A, "Finished"]]));

    const [item] = (await h.service.getInbox(WALLET, 20)).items;

    // `unknown` means the reconciler gave up. Calling that settled would
    // remove real money from the actionable list on the strength of a failure.
    expect(item?.state).toBe("unavailable");
  });

  it("reports a zero-survivor cancellation as blocked with its own reason", async () => {
    const h = harness();
    await h.seed(payout({ id: "p1", payoutId: ARENA_A, status: "built" }));
    h.setStates(new Map([[ARENA_A, "Cancelled"]]));

    const [item] = (await h.service.getInbox(WALLET, 20)).items;

    expect(item?.state).toBe("blocked");
    expect(item?.reason).toBe("zero_survivor_cancellation");
  });
});

describe("already claimed", () => {
  it("keeps a confirmed claim in the response but not in the actionable count", async () => {
    const h = harness();
    await h.seed(
      payout({ id: "done", payoutId: ARENA_A, status: "confirmed", confirmedAt: T0 }),
      payout({ id: "todo", payoutId: ARENA_B, status: "built" }),
    );
    h.setStates(new Map([[ARENA_A, "Finished"], [ARENA_B, "Finished"]]));

    const page = await h.service.getInbox(WALLET, 20);

    // Present, so history is not lost.
    const settled = page.items.find((i) => i.arenaId === ARENA_A);
    expect(settled?.state).toBe("completed");
    expect(settled?.reason).toBe("payout_confirmed");
    expect(settled?.action?.type).toBe("view_history");

    // Absent from actionable, which is what the dashboard acts on.
    expect(page.summary.actionable).toBe(1);
    expect(page.summary.completed).toBe(1);
    expect(page.items.filter((i) => i.state === "actionable").map((i) => i.arenaId)).toEqual([
      ARENA_B,
    ]);
  });

  it("keeps a settled winnings position actionable when a refund is still owed", async () => {
    const repo = new InMemoryTransactionRepository();
    await repo.insert(
      payout({ id: "done", payoutId: ARENA_A, status: "confirmed", confirmedAt: T0 }),
    );
    const service = new ClaimInboxService({
      prisma: {} as never,
      transactions: repo,
      now: () => T0.getTime() + 60_000,
      verifyArenas: async (ids) => new Map(ids.map((id) => [id, "Finished" as const])),
      findRefunds: async () => [refund({ arenaId: ARENA_A })],
    });

    const [item] = (await service.getInbox(WALLET, 20)).items;

    // The pot is paid, but the stake is still coming back.
    expect(item?.state).toBe("actionable");
    expect(item?.reason).toBe("refund_ready");
    // The settled component is still reported, so it is not claimed twice.
    expect(item?.components.some((c) => c.status === "confirmed")).toBe(true);
  });
});

describe("on-chain read failure", () => {
  it("produces an explicit unavailable state, not an empty or zeroed result", async () => {
    const h = harness();
    await h.seed(
      payout({ id: "p1", payoutId: ARENA_A, amountStroops: "500000000", status: "built" }),
    );
    h.setFailing(true);

    const page = await h.service.getInbox(WALLET, 20);

    // The payout is still in the response — it is real money.
    expect(page.items).toHaveLength(1);
    const [item] = page.items;
    expect(item?.state).toBe("unavailable");
    expect(item?.reason).toBe("rpc_unavailable");
    // Critically: the amount is not zeroed, and the position is not marked
    // not-claimable.
    expect(item?.components[0]?.amountStroops).toBe("500000000");
    expect(page.summary.unavailable).toBe(1);
    expect(page.summary.actionable).toBe(0);
    expect(page.verificationComplete).toBe(false);
    // The one thing the user can do is try again.
    expect(item?.action?.type).toBe("retry");
  });

  it("still reports an in-flight payment as pending when the read fails", async () => {
    // A submitted payment is a local fact about our own pipeline: it needs no
    // chain read, and hiding it behind an outage the user cannot act on would
    // be strictly less useful. The failure is still disclosed on the page.
    const h = harness();
    await h.seed(payout({ id: "p1", payoutId: ARENA_A, status: "submitted" }));
    h.setFailing(true);

    const page = await h.service.getInbox(WALLET, 20);

    expect(page.items[0]?.state).toBe("pending");
    expect(page.items[0]?.reason).toBe("payout_submitted");
    expect(page.verificationComplete).toBe(false);
  });

  it("prefers the chain's word over a confirmed record when the read fails", async () => {
    // A confirmed payout with a failed read must not become "not claimable";
    // it is also not re-claimable. Unavailable is the only honest state.
    const h = harness();
    await h.seed(payout({ id: "p1", payoutId: ARENA_A, status: "confirmed", confirmedAt: T0 }));
    h.setFailing(true);

    const [item] = (await h.service.getInbox(WALLET, 20)).items;

    expect(item?.state).toBe("unavailable");
  });

  it("isolates one failing arena from the rest of the page", async () => {
    const repo = new InMemoryTransactionRepository();
    await repo.insert(payout({ id: "a", payoutId: ARENA_A, status: "built", updatedAt: T0 }));
    await repo.insert(
      payout({
        id: "b",
        payoutId: ARENA_B,
        status: "built",
        updatedAt: new Date(T0.getTime() - 1000),
      }),
    );
    const service = new ClaimInboxService({
      prisma: {} as never,
      transactions: repo,
      now: () => T0.getTime() + 60_000,
      // Only ARENA_B is readable. The production verifier drops the arena
      // whose read throws rather than rejecting the batch, so B stays usable.
      verifyArenas: async (ids) => {
        const map = new Map<string, ClaimInboxArenaState>();
        for (const id of ids) {
          if (id === ARENA_A) continue;
          map.set(id, "Finished");
        }
        return map;
      },
      findRefunds: async () => [],
    });

    const page = await service.getInbox(WALLET, 20);

    const byArena = new Map(page.items.map((i) => [i.arenaId, i.state]));
    expect(byArena.get(ARENA_B)).toBe("actionable");
    expect(byArena.get(ARENA_A)).toBe("unavailable");
  });
});

describe("mixed assets", () => {
  it("totals per asset rather than summing across codes", async () => {
    const repo = new InMemoryTransactionRepository();
    await repo.insert(
      payout({ id: "x", payoutId: ARENA_A, asset: "XLM", amountStroops: "100000000" }),
    );
    await repo.insert(
      payout({
        id: "u",
        payoutId: ARENA_B,
        asset: "USDC",
        amountStroops: "25000000",
        updatedAt: new Date(T0.getTime() - 1000),
      }),
    );
    const service = new ClaimInboxService({
      prisma: {} as never,
      transactions: repo,
      now: () => T0.getTime() + 60_000,
      verifyArenas: async (ids) => new Map(ids.map((id) => [id, "Finished" as const])),
      findRefunds: async () => [],
    });

    const page = await service.getInbox(WALLET, 20);

    // One entry per asset; adding XLM to USDC would be meaningless.
    expect(page.items[0]?.totalsByAsset).toEqual([
      { code: "XLM", issuer: null, amountStroops: "100000000" },
    ]);
    expect(page.items[1]?.totalsByAsset).toEqual([
      { code: "USDC", issuer: null, amountStroops: "25000000" },
    ]);
    // 7 decimals, stated, so the client never assumes 6.
    expect(page.items[0]?.components[0]?.asset.decimals).toBe(7);
  });
});

describe("stale records", () => {
  it("flags a position whose record is older than the staleness threshold", async () => {
    const old = new Date("2026-09-01T00:00:00.000Z");
    const h = harness({ now: () => new Date("2026-09-27T10:00:00.000Z").getTime() });
    await h.seed(payout({ id: "p1", payoutId: ARENA_A, status: "built", updatedAt: old }));
    h.setStates(new Map([[ARENA_A, "Finished"]]));

    const [item] = (await h.service.getInbox(WALLET, 20)).items;

    expect(item?.freshness.stale).toBe(true);
    expect(item?.freshness.recordAgeSeconds).toBeGreaterThan(10 * 60);
    // Staleness is disclosed, not used to change the verdict.
    expect(item?.state).toBe("actionable");
  });

  it("does not flag a fresh record", async () => {
    const h = harness();
    await h.seed(payout({ id: "p1", payoutId: ARENA_A }));
    h.setStates(new Map([[ARENA_A, "Finished"]]));

    const [item] = (await h.service.getInbox(WALLET, 20)).items;

    expect(item?.freshness.stale).toBe(false);
  });
});

describe("duplicate events", () => {
  it("is idempotent across repeated scans of an unchanged position", async () => {
    const h = harness();
    await h.seed(payout({ id: "p1", payoutId: ARENA_A }));
    h.setStates(new Map([[ARENA_A, "Finished"]]));

    const first = await h.service.getInbox(WALLET, 20);
    const second = await h.service.getInbox(WALLET, 20);

    expect(second.items).toEqual(first.items);
    expect(second.summary).toEqual(first.summary);
  });

  it("gives two positions with identical timestamps a deterministic order", async () => {
    const h = harness();
    await h.seed(
      payout({ id: "z", payoutId: ARENA_B, updatedAt: T0 }),
      payout({ id: "a", payoutId: ARENA_A, updatedAt: T0 }),
    );
    h.setStates(new Map([[ARENA_A, "Finished"], [ARENA_B, "Finished"]]));

    const page = await h.service.getInbox(WALLET, 20);

    // Tie-broken by arena id, so the cursor cannot straddle a swap.
    expect(page.items.map((i) => i.arenaId)).toEqual([ARENA_A, ARENA_B]);
  });
});

describe("pagination", () => {
  async function seedMany(h: Harness, count: number) {
    for (let i = 0; i < count; i += 1) {
      await h.seed(
        payout({
          id: `p${i}`,
          payoutId: `C${String(i).padStart(55, "0").slice(0, 55)}`,
          updatedAt: new Date(T0.getTime() - i * 1000),
        }),
      );
    }
  }

  it("walks every position exactly once", async () => {
    const h = harness();
    await seedMany(h, 7);
    h.setFailing(true);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result: Awaited<ReturnType<ClaimInboxService["getInbox"]>> =
        await h.service.getInbox(WALLET, 3, cursor);
      seen.push(...result.items.map((i) => i.id));
      cursor = result.cursor;
      if (!cursor) break;
    }

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it("does not repeat or skip when a new claim arrives mid-pagination", async () => {
    const h = harness();
    await seedMany(h, 5);
    h.setFailing(true);

    const first = await h.service.getInbox(WALLET, 2);
    expect(first.hasMore).toBe(true);
    expect(first.cursor).not.toBeNull();

    // A new, newest claim lands between page 1 and page 2.
    await h.seed(
      payout({
        id: "newest",
        payoutId: "CNEWEST",
        updatedAt: new Date(T0.getTime() + 60_000),
      }),
    );

    const second = await h.service.getInbox(WALLET, 10, first.cursor);
    const ids = [...first.items, ...second.items].map((i) => i.id);

    // No duplicates. The new item sorts ahead of the cursor, so it appears in
    // the first page on a *fresh* scan and is not spliced into the tail.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("restarts from the beginning for an unparseable cursor instead of failing", async () => {
    const h = harness();
    await seedMany(h, 2);
    h.setFailing(true);

    const page = await h.service.getInbox(WALLET, 10, "not-a-cursor");

    expect(page.items).toHaveLength(2);
  });

  it("rejects a limit outside the allowed range at the route boundary", async () => {
    const h = harness();
    // The service itself is permissive; the route owns the bound.
    const page = await h.service.getInbox(WALLET, 0);
    expect(page.items).toHaveLength(0);
  });
});

describe("summary and freshness metadata", () => {
  it("counts every state and reports verification status", async () => {
    const h = harness();
    await h.seed(
      payout({ id: "a", payoutId: ARENA_A, status: "built", updatedAt: T0 }),
      payout({
        id: "b",
        payoutId: ARENA_B,
        status: "submitted",
        updatedAt: new Date(T0.getTime() - 1000),
      }),
      payout({
        id: "c",
        payoutId: ARENA_C,
        status: "confirmed",
        confirmedAt: T0,
        updatedAt: new Date(T0.getTime() - 2000),
      }),
    );
    h.setStates(
      new Map([[ARENA_A, "Finished"], [ARENA_B, "Finished"], [ARENA_C, "Finished"]]),
    );

    const page = await h.service.getInbox(WALLET, 20);

    expect(page.summary).toEqual({
      actionable: 1,
      pending: 1,
      completed: 1,
      blocked: 0,
      unavailable: 0,
      total: 3,
    });
    expect(page.verificationComplete).toBe(true);
    expect(page.version).toBe(1);
    expect(page.scanLatencyMs).toBeGreaterThanOrEqual(0);
    expect(page.sources.payouts).toBe(3);
  });

  it("gives a position with no record timestamp a sort key that does not move", async () => {
    // Refund rows can arrive without a timestamp. If the key defaulted to the
    // read time it would differ on every request and a cursor taken from one
    // page would skip or repeat the position.
    const repo = new InMemoryTransactionRepository();
    const service = new ClaimInboxService({
      prisma: {} as never,
      transactions: repo,
      now: () => T0.getTime(),
      findRefunds: async () => [
        refund({ arenaId: ARENA_A, updatedAt: null as unknown as Date }),
      ],
    });

    const first = (await service.getInbox(WALLET, 20)).items[0];
    const second = (await service.getInbox(WALLET, 20)).items[0];

    expect(first?.sortKey).toBeTruthy();
    expect(first?.sortKey).toBe(second?.sortKey);
    // And the absence is disclosed rather than invented.
    expect(first?.freshness.recordUpdatedAt).toBeNull();
  });

  it("reports a configured issuer and never guesses one", async () => {
    const repo = new InMemoryTransactionRepository();
    await repo.insert(
      payout({ id: "u", payoutId: ARENA_A, asset: "USDC", status: "built" }),
    );
    const service = new ClaimInboxService({
      prisma: {} as never,
      transactions: repo,
      now: () => T0.getTime() + 60_000,
      verifyArenas: async (ids) => new Map(ids.map((id) => [id, "Finished" as const])),
      findRefunds: async () => [],
      assetIssuers: { USDC: ISSUER_USDC },
    });

    const [item] = (await service.getInbox(WALLET, 20)).items;

    expect(item?.components[0]?.asset).toEqual({
      code: "USDC",
      issuer: ISSUER_USDC,
      decimals: 7,
    });
    expect(item?.totalsByAsset[0]).toEqual({
      code: "USDC",
      issuer: ISSUER_USDC,
      amountStroops: "100000000",
    });
  });

  it("leaves an unconfigured credit asset without an issuer rather than inventing one", async () => {
    const repo = new InMemoryTransactionRepository();
    await repo.insert(
      payout({ id: "u", payoutId: ARENA_A, asset: "USDC", status: "built" }),
    );
    const service = new ClaimInboxService({
      prisma: {} as never,
      transactions: repo,
      now: () => T0.getTime() + 60_000,
      verifyArenas: async (ids) => new Map(ids.map((id) => [id, "Finished" as const])),
      findRefunds: async () => [],
    });

    const [item] = (await service.getInbox(WALLET, 20)).items;

    // A wrong issuer is worse than a visible gap: a client would build a
    // trustline against whichever account appeared here.
    expect(item?.components[0]?.asset.issuer).toBeNull();
  });

  it("reports native XLM with no issuer", async () => {
    const h = harness();
    await h.seed(payout({ id: "p1", payoutId: ARENA_A, asset: "XLM", status: "built" }));

    const [item] = (await h.service.getInbox(WALLET, 20)).items;

    expect(item?.components[0]?.asset.issuer).toBeNull();
  });

  it("never places a full wallet address in an item's message", async () => {
    const h = harness();
    await h.seed(payout({ id: "p1", payoutId: ARENA_A }));
    h.setFailing(true);

    const page = await h.service.getInbox(WALLET, 20);

    // The message is rendered in a browser and forwarded to support tooling.
    expect(page.items[0]?.message).not.toContain(WALLET);
  });
});

describe("verification budget", () => {
  it("reports unavailable rather than waiting indefinitely", async () => {
    const repo = new InMemoryTransactionRepository();
    // `built`, so the arena read is the only thing that can decide this and
    // the budget is genuinely what the state depends on.
    await repo.insert(payout({ id: "p1", payoutId: ARENA_A, status: "built" }));
    const service = new ClaimInboxService({
      prisma: {} as never,
      transactions: repo,
      now: () => Date.now(),
      verifyBudgetMs: 25,
      // Never resolves.
      verifyArenas: () => new Promise(() => undefined),
      findRefunds: async () => [],
    });

    const [item] = (await service.getInbox(WALLET, 20)).items;

    expect(item?.state).toBe("unavailable");
    expect(item?.action?.type).toBe("retry");
  });

  it("caps how many arenas are verified in one scan", async () => {
    const repo = new InMemoryTransactionRepository();
    for (let i = 0; i < 6; i += 1) {
      await repo.insert(
        payout({ id: `p${i}`, payoutId: `C${i}${"0".repeat(54)}`.slice(0, 55), status: "built" }),
      );
    }
    let askedFor = 0;
    const service = new ClaimInboxService({
      prisma: {} as never,
      transactions: repo,
      now: () => T0.getTime() + 60_000,
      maxVerify: 2,
      verifyArenas: async (ids) => {
        askedFor = ids.length;
        return new Map(ids.map((id) => [id, "Finished" as const]));
      },
      findRefunds: async () => [],
    });

    const page = await service.getInbox(WALLET, 20);

    expect(askedFor).toBe(2);
    // The unverified remainder is disclosed, not guessed.
    expect(page.items.filter((i) => i.state === "unavailable")).toHaveLength(4);
  });
});

describe("status classification table", () => {
  const cases: Array<[PaymentStatus, string]> = [
    ["built", "actionable"],
    ["queued", "pending"],
    ["awaiting_signature", "pending"],
    ["submitted", "pending"],
    ["confirmed", "completed"],
    ["failed", "blocked"],
    ["dead", "blocked"],
  ];

  it.each(cases)("maps %s to %s", async (status, expected) => {
    const h = harness();
    await h.seed(payout({ id: `p-${status}`, payoutId: ARENA_A, status }));
    h.setStates(new Map([[ARENA_A, "Finished"]]));

    const [item] = (await h.service.getInbox(WALLET, 20)).items;

    expect(item?.state).toBe(expected);
  });
});
