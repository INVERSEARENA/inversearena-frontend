/**
 * Regression test for #1342.
 *
 * `confirmArenaDeployment` used to trust any successful Soroban transaction
 * whose return value decoded to an Address. An authenticated caller could
 * therefore deploy a trivial contract of their own, invoke it, and register the
 * result as a legitimate arena — never touching the real factory's
 * `create_pool`. The service must now assert the transaction actually invoked
 * `create_pool` on `ARENA_FACTORY_CONTRACT_ID` before persisting anything.
 */
import { test } from "node:test";
import assert from "node:assert";
import {
  Account,
  Address,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";

import { ArenaService, setRpcServerForTest } from "../src/services/arenaService";
import type { CreateArenaInput } from "../src/types/arena";

const PASSPHRASE = Networks.TESTNET;
const FACTORY_ID = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
const IMPOSTOR_ID = "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ";
const DEPLOYED_ARENA_ID = "CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3";
const TX_HASH = "a".repeat(64);
const SOURCE = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

process.env.SOROBAN_RPC_URL ??= "https://soroban-testnet.stellar.org";
process.env.STELLAR_NETWORK_PASSPHRASE = PASSPHRASE;
process.env.ARENA_FACTORY_CONTRACT_ID = FACTORY_ID;

const input: CreateArenaInput = {
  name: "Test Arena",
  entryFee: 10,
  maxPlayers: 8,
  joinDeadline: "2026-01-01T00:00:00.000Z",
  stakeToken: "USDC",
};

function buildEnvelope(contractId: string, functionName: string): string {
  const account = new Account(SOURCE, "1");
  const contract = new Contract(contractId);

  return new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(contract.call(functionName, nativeToScVal(1, { type: "u32" })))
    .setTimeout(30)
    .build()
    .toXDR();
}

function stubServer(envelopeXdr: string) {
  return {
    getTransaction: async () => ({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      envelopeXdr,
      returnValue: new Address(DEPLOYED_ARENA_ID).toScVal(),
    }),
  } as unknown as rpc.Server;
}

function serviceWithRecordingPrisma() {
  const created: unknown[] = [];
  const prisma = {
    arena: {
      create: async (args: { data: { id: string; metadata: unknown } }) => {
        created.push(args.data);
        return {
          id: args.data.id,
          metadata: args.data.metadata,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        };
      },
    },
  };

  return {
    created,
    service: new ArenaService(prisma as never, {} as never),
  };
}

test.afterEach(() => {
  setRpcServerForTest(null);
  process.env.ARENA_FACTORY_CONTRACT_ID = FACTORY_ID;
});

test("confirmArenaDeployment rejects a successful transaction that invoked an unrelated contract", async () => {
  setRpcServerForTest(stubServer(buildEnvelope(IMPOSTOR_ID, "create_pool")));
  const { service, created } = serviceWithRecordingPrisma();

  await assert.rejects(
    () => service.confirmArenaDeployment(input, SOURCE, TX_HASH),
    /did not invoke the arena factory contract/,
  );
  assert.strictEqual(created.length, 0, "no arena row may be written for a forged deployment");
});

test("confirmArenaDeployment rejects a factory transaction that did not call create_pool", async () => {
  setRpcServerForTest(stubServer(buildEnvelope(FACTORY_ID, "join_pool")));
  const { service, created } = serviceWithRecordingPrisma();

  await assert.rejects(
    () => service.confirmArenaDeployment(input, SOURCE, TX_HASH),
    /did not call create_pool/,
  );
  assert.strictEqual(created.length, 0);
});

test("confirmArenaDeployment accepts a real factory create_pool invocation", async () => {
  setRpcServerForTest(stubServer(buildEnvelope(FACTORY_ID, "create_pool")));
  const { service, created } = serviceWithRecordingPrisma();

  const arena = await service.confirmArenaDeployment(input, SOURCE, TX_HASH);

  assert.strictEqual(arena.id, DEPLOYED_ARENA_ID);
  assert.strictEqual(created.length, 1);
});

test("confirmArenaDeployment refuses to run when the factory contract is unconfigured", async () => {
  delete process.env.ARENA_FACTORY_CONTRACT_ID;
  setRpcServerForTest(stubServer(buildEnvelope(FACTORY_ID, "create_pool")));
  const { service } = serviceWithRecordingPrisma();

  await assert.rejects(
    () => service.confirmArenaDeployment(input, SOURCE, TX_HASH),
    /ARENA_FACTORY_CONTRACT_ID is not configured/,
  );
});

test("getSnapshot aggregates arena state and extracts recent eliminations", async () => {
  const prisma = {
    arena: {
      findUnique: async () => ({
        id: DEPLOYED_ARENA_ID,
        rounds: [
          {
            roundNumber: 1,
            state: "RESOLVED",
            eliminationLogs: [
              {
                id: "elimination-1",
                userId: "user-1",
                reason: "minority",
                eliminatedAt: new Date("2026-01-02T00:00:00.000Z"),
              },
            ],
          },
          { roundNumber: 2, state: "OPEN", eliminationLogs: [] },
        ],
      }),
    },
  };
  const statsService = {
    getArenaStats: async () => ({
      currentRound: 2,
      playerCount: 8,
      survivorCount: 4,
      status: "active",
    }),
  };
  const service = new ArenaService(prisma as never, statsService as never);

  const snapshot = await service.getSnapshot(DEPLOYED_ARENA_ID);

  assert.deepStrictEqual(snapshot, {
    arenaId: DEPLOYED_ARENA_ID,
    currentRound: 2,
    playerCount: 8,
    survivorCount: 4,
    status: "active",
    recentEliminations: [
      {
        id: "elimination-1",
        userId: "user-1",
        roundNumber: 1,
        reason: "minority",
        eliminatedAt: "2026-01-02T00:00:00.000Z",
      },
    ],
    lastRoundState: "OPEN",
  });
});

test("getSnapshot rejects an arena that does not exist", async () => {
  const prisma = { arena: { findUnique: async () => null } };
  const statsService = {
    getArenaStats: async () => ({
      currentRound: 0,
      playerCount: 0,
      survivorCount: 0,
      status: "missing",
    }),
  };
  const service = new ArenaService(prisma as never, statsService as never);

  await assert.rejects(
    () => service.getSnapshot(DEPLOYED_ARENA_ID),
    /Arena with ID .* not found/,
  );
});
