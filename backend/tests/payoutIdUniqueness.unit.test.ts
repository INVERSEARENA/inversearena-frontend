import { test, mock, afterEach } from "node:test";
import assert from "node:assert";
import { rpc } from "@stellar/stellar-sdk";
const { Server } = rpc;
import { PaymentService, PayoutConflictError } from "../src/services/paymentService";
import { InMemoryTransactionRepository } from "../src/repositories/inMemoryTransactionRepository";
import type { PaymentConfig } from "../src/config/paymentConfig";

/**
 * payoutId uniqueness (#1353).
 *
 * De-duplication used to key solely on the caller-supplied idempotencyKey, and
 * payoutId carried no unique constraint in either store. A retry after an
 * ambiguous timeout — which typically mints a *fresh* key — therefore passed the
 * check, reserved its own nonce, and produced a second independently
 * submittable on-chain payout for the same prize.
 */

const VALID_ADDRESS = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

const mockConfig: PaymentConfig = {
  liveExecution: true,
  signWithHotKey: false,
  maxGasStroops: 2000000,
  maxAttempts: 5,
  confirmPollMs: 100,
  confirmMaxPolls: 3,
  failedRetryMax: 3,
  failedRetryBaseMs: 5000,
  payoutMethodName: "distribute_winnings",
  payoutContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
  sourceAccount: VALID_ADDRESS,
  hotSignerSecret: undefined,
  networkPassphrase: "Test SDF Network ; September 2015",
  sorobanRpcUrl: "https://soroban-testnet.stellar.org",
};

function buildService() {
  const transactions = new InMemoryTransactionRepository();

  const mockRpcServer = {
    getAccount: mock.fn(async () => ({
      sequenceNumber: () => "1",
      accountId: () => mockConfig.sourceAccount,
      incrementSequenceNumber: () => {},
    })),
    prepareTransaction: mock.fn(async (tx: any) => ({
      fee: "100",
      toXDR: () => tx.toXDR(),
      sign: () => {},
    })),
    sendTransaction: mock.fn(async () => ({ status: "PENDING", hash: "tx-hash" })),
    getTransaction: mock.fn(async () => ({ status: "SUCCESS" })),
  } as unknown as InstanceType<typeof Server>;

  const service = new PaymentService(transactions, {
    config: mockConfig,
    rpcServer: mockRpcServer,
  });

  return { service, transactions };
}

function payoutRequest(payoutId: string, idempotencyKey: string) {
  return {
    payoutId,
    destinationAccount: VALID_ADDRESS,
    amount: "10.5",
    asset: "XLM",
    idempotencyKey,
  };
}

afterEach(() => {
  mock.reset();
});

test("a retry with a fresh idempotency key cannot create a second payout", async () => {
  const { service } = buildService();

  await service.createPayoutTransaction(payoutRequest("payout-1", "key-original"));

  await assert.rejects(
    () => service.createPayoutTransaction(payoutRequest("payout-1", "key-retry")),
    (err: unknown) => {
      assert.ok(err instanceof PayoutConflictError, "must be a payout conflict");
      assert.strictEqual((err as PayoutConflictError).status, 409);
      assert.strictEqual((err as PayoutConflictError).payoutId, "payout-1");
      return true;
    },
  );
});

test("the duplicate attempt leaves exactly one transaction for the payout", async () => {
  const { service, transactions } = buildService();

  const first = await service.createPayoutTransaction(payoutRequest("payout-2", "key-alpha-0001"));
  await assert.rejects(() =>
    service.createPayoutTransaction(payoutRequest("payout-2", "key-bravo-0002")),
  );

  const stored = await transactions.findByPayoutId("payout-2");
  assert.ok(stored);
  assert.strictEqual(stored!.id, first.transaction.id);
  assert.strictEqual(stored!.idempotencyKey, "key-alpha-0001");
});

test("the duplicate attempt does not burn a nonce", async () => {
  const { service, transactions } = buildService();

  const first = await service.createPayoutTransaction(payoutRequest("payout-3", "key-alpha-0001"));
  await assert.rejects(() =>
    service.createPayoutTransaction(payoutRequest("payout-3", "key-bravo-0002")),
  );

  // A rejected duplicate must not consume a sequence number: the guard runs
  // before reserveNextNonce, so the next real payout gets the next nonce.
  const next = await service.createPayoutTransaction(payoutRequest("payout-4", "key-charlie-003"));
  assert.strictEqual(next.transaction.nonce, first.transaction.nonce + 1);
});

test("replaying the original idempotency key still returns the existing payout", async () => {
  const { service } = buildService();

  const first = await service.createPayoutTransaction(payoutRequest("payout-5", "key-same"));
  const replay = await service.createPayoutTransaction(payoutRequest("payout-5", "key-same"));

  // The normal idempotent retry path must keep working — it is what callers are
  // told to do instead of generating a new key.
  assert.strictEqual(replay.transaction.id, first.transaction.id);
  assert.strictEqual(replay.unsignedXdr, first.unsignedXdr);
});

test("different payout ids are unaffected", async () => {
  const { service } = buildService();

  const a = await service.createPayoutTransaction(payoutRequest("payout-6", "key-alpha-0001"));
  const b = await service.createPayoutTransaction(payoutRequest("payout-7", "key-bravo-0002"));

  assert.notStrictEqual(a.transaction.id, b.transaction.id);
  assert.notStrictEqual(a.transaction.nonce, b.transaction.nonce);
});

test("the conflict message tells the caller how to recover", async () => {
  const { service } = buildService();

  await service.createPayoutTransaction(payoutRequest("payout-8", "key-alpha-0001"));

  await assert.rejects(
    () => service.createPayoutTransaction(payoutRequest("payout-8", "key-bravo-0002")),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.match(message, /payout-8/);
      assert.match(message, /idempotency key/i);
      return true;
    },
  );
});
