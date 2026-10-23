/**
 * Rematch pools (#1572).
 *
 * Covers the pure availability decision and the chain→prefill derivation in
 * `RematchService`, plus the prior-participant notification fan-out. The
 * actual `Arena.rematchOf` linkage (and its idempotency) is exercised in
 * `arenaService.deployment.unit.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert";

import {
  evaluateRematchEligibility,
  REMATCH_BLOCKED_MESSAGES,
  RematchArenaNotFoundError,
  RematchConfigUnavailableError,
  RematchService,
  type RematchReaders,
} from "../../src/services/rematchService";
import type { OnChainReadResult } from "../../src/types/onChainRead";
import type { OnChainGameState } from "../../src/services/onChainReader";
import { ArenaService } from "../../src/services/arenaService";
import { redis } from "../../src/cache/redisClient";
import type { CreateArenaInput } from "../../src/types/arena";
import {
  Account,
  Address,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";

const ARENA_ID = "CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3";
const FACTORY_ID = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
const HOST = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const TOKEN = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VAULT = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const ORACLE = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const SOURCE_ARENA = "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ";
const HOST_KEY = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const TX_HASH = "a".repeat(64);

test.after(() => {
  redis.disconnect();
});

process.env.SOROBAN_RPC_URL ??= "https://soroban-testnet.stellar.org";
process.env.STELLAR_NETWORK_PASSPHRASE = Networks.TESTNET;
process.env.ARENA_FACTORY_CONTRACT_ID = FACTORY_ID;

const goodChecks = {
  sourceFinished: true,
  tokenSupported: true,
  vaultApproved: true,
  oracleApproved: true,
  hostActivePoolCount: 0,
  hostMaxActivePools: 5,
};

function gameState(value: OnChainGameState): OnChainReadResult<OnChainGameState> {
  return {
    outcome: "verified",
    value,
    provenance: {
      functionName: "game_state",
      contractId: ARENA_ID,
      network: "test",
      ledgerSequence: 1,
      observedAt: "2026-01-01T00:00:00.000Z",
      retryable: false,
    },
  };
}

function readers(overrides: Partial<RematchReaders> = {}): RematchReaders {
  return {
    getArenaPoolConfig: async () => ({
      stakeToken: TOKEN,
      yieldVault: VAULT,
      entryFee: 100n,
      oracleContract: ORACLE,
      minPlayers: 2,
      maxPlayers: 8,
      roundDuration: 300,
      startDeadline: 1_700_000_000,
      factory: FACTORY_ID,
      poolId: 12,
    }),
    readOnChainGameState: async () => gameState("Finished"),
    isFactoryTokenSupported: async () => true,
    isFactoryVaultApproved: async () => true,
    isFactoryOracleApproved: async () => true,
    getFactoryActivePoolCount: async () => 1,
    getFactoryMaxActivePools: async () => 5,
    ...overrides,
  };
}

function fakePrisma(options: {
  arena?: unknown;
  user?: unknown;
  elimination?: unknown;
  rounds?: unknown[];
  priorParticipantRound?: unknown;
} = {}) {
  return {
    arena: {
      findUnique: async () =>
        options.arena === undefined
          ? { id: ARENA_ID, metadata: { createdBy: HOST } }
          : options.arena,
    },
    user: {
      findUnique: async () => options.user ?? { id: "user-1" },
      findMany: async () => [{ id: "user-1" }, { id: "user-2" }],
    },
    eliminationLog: {
      findFirst: async () => options.elimination ?? null,
      findMany: async () => [{ userId: "user-1" }, { userId: "user-2" }],
    },
    round: {
      findFirst: async () => options.priorParticipantRound ?? null,
      findMany: async () => options.rounds ?? [{ allActivePlayerIds: ["GWALLET1"] }],
    },
  };
}

// ── evaluateRematchEligibility ──────────────────────────────────────────────

test("rematch is available when the source finished and every policy still passes", () => {
  const result = evaluateRematchEligibility(goodChecks);
  assert.deepStrictEqual(result, {
    available: true,
    blockedReason: null,
    blockedMessage: null,
  });
});

test("rematch is blocked while the source arena is still running", () => {
  const result = evaluateRematchEligibility({ ...goodChecks, sourceFinished: false });
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.blockedReason, "SOURCE_ARENA_NOT_FINISHED");
  assert.strictEqual(result.blockedMessage, REMATCH_BLOCKED_MESSAGES.SOURCE_ARENA_NOT_FINISHED);
});

test("rematch is blocked when the stake token was delisted", () => {
  const result = evaluateRematchEligibility({ ...goodChecks, tokenSupported: false });
  assert.strictEqual(result.blockedReason, "STAKE_TOKEN_NOT_SUPPORTED");
});

test("rematch is blocked when the yield vault is no longer approved", () => {
  const result = evaluateRematchEligibility({ ...goodChecks, vaultApproved: false });
  assert.strictEqual(result.blockedReason, "YIELD_VAULT_NOT_APPROVED");
});

test("rematch is blocked when the oracle is no longer approved", () => {
  const result = evaluateRematchEligibility({ ...goodChecks, oracleApproved: false });
  assert.strictEqual(result.blockedReason, "ORACLE_NOT_APPROVED");
});

test("rematch is blocked once the host reaches max_active_pools", () => {
  const result = evaluateRematchEligibility({
    ...goodChecks,
    hostActivePoolCount: 5,
    hostMaxActivePools: 5,
  });
  assert.strictEqual(result.blockedReason, "HOST_ACTIVE_POOL_LIMIT");
});

test("finishing is reported before a delisted token (the prerequisite comes first)", () => {
  const result = evaluateRematchEligibility({
    ...goodChecks,
    sourceFinished: false,
    tokenSupported: false,
  });
  assert.strictEqual(result.blockedReason, "SOURCE_ARENA_NOT_FINISHED");
});

// ── RematchService.getRematchConfig ─────────────────────────────────────────

test("getRematchConfig prefills from the arena's canonical on-chain config", async () => {
  const service = new RematchService(
    fakePrisma({ priorParticipantRound: { id: "round-1" } }) as never,
    readers(),
  );

  const config = await service.getRematchConfig(ARENA_ID, "GWALLET1");

  assert.strictEqual(config.arenaId, ARENA_ID);
  assert.strictEqual(config.available, true);
  assert.strictEqual(config.host, HOST);
  assert.strictEqual(config.poolId, 12);
  assert.strictEqual(config.factoryContractId, FACTORY_ID);
  assert.strictEqual(config.isPriorParticipant, true);
  assert.deepStrictEqual(config.config, {
    stakeToken: TOKEN,
    yieldVault: VAULT,
    // i128 is preserved as a string across the wire.
    entryFee: "100",
    oracleContract: ORACLE,
    minPlayers: 2,
    maxPlayers: 8,
    roundDuration: 300,
  });
});

test("getRematchConfig reports a blocked rematch instead of failing", async () => {
  const service = new RematchService(
    fakePrisma() as never,
    readers({ isFactoryTokenSupported: async () => false }),
  );

  const config = await service.getRematchConfig(ARENA_ID);

  assert.strictEqual(config.available, false);
  assert.strictEqual(config.blockedReason, "STAKE_TOKEN_NOT_SUPPORTED");
  assert.strictEqual(config.isPriorParticipant, false);
});

test("getRematchConfig treats an unavailable game-state read as not finished", async () => {
  const service = new RematchService(
    fakePrisma() as never,
    readers({
      readOnChainGameState: async () => ({
        outcome: "unavailable",
        provenance: {
          functionName: "game_state",
          contractId: ARENA_ID,
          network: "test",
          ledgerSequence: null,
          observedAt: "2026-01-01T00:00:00.000Z",
          retryable: true,
        },
        error: { code: "transport", message: "RPC down" },
      }),
    }),
  );

  const config = await service.getRematchConfig(ARENA_ID);
  assert.strictEqual(config.blockedReason, "SOURCE_ARENA_NOT_FINISHED");
});

test("getRematchConfig rejects an unknown arena", async () => {
  const service = new RematchService(fakePrisma({ arena: null }) as never, readers());
  await assert.rejects(
    () => service.getRematchConfig(ARENA_ID),
    (error: unknown) => error instanceof RematchArenaNotFoundError,
  );
});

test("getRematchConfig surfaces an unreadable on-chain config", async () => {
  const service = new RematchService(
    fakePrisma() as never,
    readers({
      getArenaPoolConfig: async () => {
        throw new Error("simulation failed");
      },
    }),
  );
  await assert.rejects(
    () => service.getRematchConfig(ARENA_ID),
    (error: unknown) => error instanceof RematchConfigUnavailableError,
  );
});

test("getRematchConfig rejects an arena with no recorded host", async () => {
  const service = new RematchService(
    fakePrisma({ arena: { id: ARENA_ID, metadata: {} } }) as never,
    readers(),
  );
  await assert.rejects(
    () => service.getRematchConfig(ARENA_ID),
    (error: unknown) => error instanceof RematchConfigUnavailableError,
  );
});

// ── notifyPriorParticipants ────────────────────────────────────────────────

test("notifyPriorParticipants records one deduped in-app delivery per participant", async () => {
  const recorded: Array<{ userId: string; type: string; channel: string; dedupeKey: string }> = [];
  const marked: string[] = [];
  const prefs = {
    shouldNotify: async () => true,
    recordDelivery: async (userId: string, type: string, channel: string, dedupeKey: string) => {
      recorded.push({ userId, type, channel, dedupeKey });
      return `delivery-${userId}`;
    },
    markSent: async (id: string) => {
      marked.push(id);
    },
  } as never;
  const push = { scheduleRoundPhasePushes: async () => ({}) } as never;

  const service = new RematchService(fakePrisma() as never, readers());
  const notified = await service.notifyPriorParticipants(ARENA_ID, "CREMATCH", prefs, push);

  assert.strictEqual(notified, 2);
  assert.deepStrictEqual(
    recorded.map((r) => r.userId).sort(),
    ["user-1", "user-2"],
  );
  for (const delivery of recorded) {
    assert.strictEqual(delivery.type, "rematch");
    assert.strictEqual(delivery.channel, "in_app");
    assert.strictEqual(delivery.dedupeKey, `rematch:${ARENA_ID}:CREMATCH`);
  }
  assert.deepStrictEqual(marked, ["delivery-user-1", "delivery-user-2"]);
});

test("notifyPriorParticipants skips opted-out users without creating deliveries", async () => {
  const recorded: string[] = [];
  const prefs = {
    shouldNotify: async () => false,
    recordDelivery: async (userId: string) => {
      recorded.push(userId);
      return "id";
    },
    markSent: async () => {},
  } as never;
  const push = { scheduleRoundPhasePushes: async () => ({}) } as never;

  const service = new RematchService(fakePrisma() as never, readers());
  const notified = await service.notifyPriorParticipants(ARENA_ID, "CREMATCH", prefs, push);

  assert.strictEqual(notified, 0);
  assert.deepStrictEqual(recorded, []);
});

test("notifyPriorParticipants never throws when a notification backend fails", async () => {
  const prefs = {
    shouldNotify: async () => {
      throw new Error("prefs down");
    },
    recordDelivery: async () => "id",
    markSent: async () => {},
  } as never;
  const push = {
    scheduleRoundPhasePushes: async () => {
      throw new Error("push down");
    },
  } as never;

  const service = new RematchService(fakePrisma() as never, readers());
  const notified = await service.notifyPriorParticipants(ARENA_ID, "CREMATCH", prefs, push);
  assert.strictEqual(notified, 0);
});

// ── ArenaService.confirmArenaDeployment linkage (idempotency) ───────────────

const createInput: CreateArenaInput = {
  name: "Rematch Arena",
  entryFee: 10,
  maxPlayers: 8,
  joinDeadline: "2026-01-01T00:00:00.000Z",
  stakeToken: "USDC",
};

function deploymentGateway(arenaId: string) {
  const account = new Account(HOST_KEY, "1");
  const envelopeXdr = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(new Contract(FACTORY_ID).call("create_pool", nativeToScVal(1, { type: "u32" })))
    .setTimeout(30)
    .build()
    .toXDR();

  return {
    getTransaction: async () => ({
      status: "SUCCESS",
      envelopeXdr,
      returnValue: new Address(arenaId).toScVal(),
    }),
  } as never;
}

function deploymentService(
  existing: Record<
    string,
    { id: string; metadata: unknown; rematchOf: string | null; createdAt?: Date; updatedAt?: Date }
  > = {},
) {
  const created: Array<{ id: string; rematchOf?: string | null }> = [];
  // Upstream wraps the create + outbox append in a $transaction (#1701); the
  // rematch linkage rides along inside it, so the stub must provide one.
  const transactionClient = {
    arena: {
      create: async (args: { data: { id: string; rematchOf?: string | null } }) => {
        created.push(args.data);
        return {
          id: args.data.id,
          metadata: {},
          rematchOf: args.data.rematchOf ?? null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        };
      },
    },
    outboxEvent: { create: async () => {} },
  };
  const prisma = {
    arena: {
      findUnique: async (args: { where: { id: string } }) => existing[args.where.id] ?? null,
    },
    $transaction: async <T>(callback: (tx: typeof transactionClient) => Promise<T>) =>
      callback(transactionClient),
  };

  return {
    created,
    service: new ArenaService(prisma as never, {} as never, deploymentGateway(ARENA_ID)),
  };
}

test("confirmArenaDeployment persists the rematchOf linkage", async () => {
  const { service, created } = deploymentService({
    [SOURCE_ARENA]: { id: SOURCE_ARENA, metadata: { createdBy: HOST }, rematchOf: null },
  });

  const arena = await service.confirmArenaDeployment(
    { ...createInput, rematchOf: SOURCE_ARENA },
    HOST,
    TX_HASH,
  );

  assert.strictEqual(arena.id, ARENA_ID);
  assert.strictEqual(created[0]?.rematchOf, SOURCE_ARENA);
});

test("confirmArenaDeployment is idempotent for a re-submitted rematch linkage", async () => {
  const { service, created } = deploymentService({
    [SOURCE_ARENA]: { id: SOURCE_ARENA, metadata: { createdBy: HOST }, rematchOf: null },
    [ARENA_ID]: {
      id: ARENA_ID,
      metadata: { createdBy: HOST },
      rematchOf: SOURCE_ARENA,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });

  const arena = await service.confirmArenaDeployment(
    { ...createInput, rematchOf: SOURCE_ARENA },
    HOST,
    TX_HASH,
  );

  assert.strictEqual(arena.id, ARENA_ID);
  assert.strictEqual(created.length, 0, "an idempotent retry must not write a second row");
});

test("confirmArenaDeployment rejects a conflicting rematch linkage", async () => {
  const { service, created } = deploymentService({
    [SOURCE_ARENA]: { id: SOURCE_ARENA, metadata: { createdBy: HOST }, rematchOf: null },
    [ARENA_ID]: { id: ARENA_ID, metadata: { createdBy: HOST }, rematchOf: null },
  });

  await assert.rejects(
    () =>
      service.confirmArenaDeployment({ ...createInput, rematchOf: SOURCE_ARENA }, HOST, TX_HASH),
    /different rematch linkage/,
  );
  assert.strictEqual(created.length, 0);
});

test("confirmArenaDeployment rejects a rematch whose source arena is unknown", async () => {
  const { service, created } = deploymentService();

  await assert.rejects(
    () =>
      service.confirmArenaDeployment({ ...createInput, rematchOf: SOURCE_ARENA }, HOST, TX_HASH),
    /Rematch source arena .* not found/,
  );
  assert.strictEqual(created.length, 0);
});
