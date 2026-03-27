import { test, mock, afterEach } from "node:test";
import assert from "node:assert";
import { rpc, TransactionBuilder } from "@stellar/stellar-sdk";
const { Server } = rpc;
import { PaymentService } from "../src/services/paymentService";
import { InMemoryTransactionRepository } from "../src/repositories/inMemoryTransactionRepository";
import type { PaymentConfig } from "../src/config/paymentConfig";

const VALID_ADDRESS = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const VALID_IDEMPOTENCY = "idempotency-key-123";

const mockConfig: PaymentConfig = {
  liveExecution: true,
  signWithHotKey: false,
  maxGasStroops: 2000000,
  maxAttempts: 5,
  confirmPollMs: 100,
  confirmMaxPolls: 3,
  payoutMethodName: "distribute_winnings",
  payoutContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
  sourceAccount: VALID_ADDRESS,
  hotSignerSecret: undefined,
  networkPassphrase: "Test SDF Network ; September 2015",
  sorobanRpcUrl: "https://soroban-testnet.stellar.org",
};

const transactions = new InMemoryTransactionRepository();

// Mock Server
const mockRpcServer = {
  getAccount: mock.fn(async () => ({
    sequenceNumber: () => "1",
    accountId: () => mockConfig.sourceAccount,
    incrementSequenceNumber: () => {},
  })),
  prepareTransaction: mock.fn(async (tx: any) => {
    return {
      fee: "100",
      toXDR: () => tx.toXDR(),
      sign: () => {},
    };
  }),
  sendTransaction: mock.fn(async () => ({
    status: "PENDING",
    hash: "tx-hash",
  })),
  getTransaction: mock.fn(async () => ({
    status: "SUCCESS",
  })),
} as unknown as Server;

const paymentService = new PaymentService(transactions, { 
  config: mockConfig,
  rpcServer: mockRpcServer
});

afterEach(() => {
  mock.reset();
});

test("PaymentService.createPayoutTransaction: successful creation", async () => {
  const input = {
    payoutId: "p-1",
    destinationAccount: VALID_ADDRESS,
    amount: "10.5",
    asset: "XLM",
    idempotencyKey: VALID_IDEMPOTENCY,
  };

  const result = await paymentService.createPayoutTransaction(input);

  assert.strictEqual(result.transaction.status, "awaiting_signature");
  assert.strictEqual(result.transaction.amountStroops, "105000000");
  assert.ok(result.unsignedXdr);
  
  assert.strictEqual((mockRpcServer.getAccount as any).mock.callCount(), 1);
});

test("PaymentService.createPayoutTransaction: idempotency", async () => {
  const input = {
    payoutId: "p-2",
    destinationAccount: VALID_ADDRESS,
    amount: "5",
    asset: "XLM",
    idempotencyKey: "another-idempotency-key",
  };

  const result1 = await paymentService.createPayoutTransaction(input);
  const result2 = await paymentService.createPayoutTransaction(input);

  assert.strictEqual(result1.transaction.id, result2.transaction.id);
});

test("PaymentService.createPayoutTransaction: invalid input", async () => {
  const input = {
    payoutId: "p-3",
    destinationAccount: "INVALID",
    amount: "10",
    asset: "XLM",
    idempotencyKey: "idem", // Too short
  };

  await assert.rejects(
    () => paymentService.createPayoutTransaction(input),
    (err: any) => err.name === "ZodError"
  );
});

test("PaymentService.submitQueuedTransaction: success", async () => {
  const txId = "tx-123";
  const signedXdr = "AAAA...base64...";
  
  mock.method(TransactionBuilder, "fromXDR", () => ({}));
  
  await transactions.insert({
    id: txId,
    status: "queued",
    signedXdr,
    attempts: 0,
    idempotencyKey: "some-key-8-chars",
  } as any);

  const result = await paymentService.submitQueuedTransaction(txId);

  assert.strictEqual(result.submitted, true);
  assert.strictEqual(result.transaction.status, "submitted");
  assert.strictEqual((mockRpcServer.sendTransaction as any).mock.callCount(), 1);
});

test("PaymentService.submitQueuedTransaction: Soroban rejection", async () => {
  const txId = "tx-456";
  
  mock.method(TransactionBuilder, "fromXDR", () => ({}));
  (mockRpcServer.sendTransaction as any).mock.mockImplementationOnce(async () => ({
    status: "ERROR",
    hash: "failed-hash"
  }));

  await transactions.insert({
    id: txId,
    status: "queued",
    signedXdr: "sig",
    attempts: 0,
    idempotencyKey: "another-key-8-chars",
  } as any);

  const result = await paymentService.submitQueuedTransaction(txId);

  assert.strictEqual(result.submitted, false);
  assert.strictEqual(result.transaction.status, "failed");
  assert.match(result.transaction.errorMessage!, /rejected/);
});
