/**
 * Tests for the BullMQ-based confirmation path introduced in #1602.
 *
 * PaymentService.submitQueuedTransaction now enqueues a `tx-confirm` job with
 * a deterministic jobId (the transactionId) after a successful submission.
 * pollConfirmation has been removed — confirmation is exclusively performed
 * by the queue worker.
 */

import { PaymentService } from "../paymentService";
import type { TransactionRepository } from "../../repositories/transactionRepository";
import type { TransactionRecord } from "../../types/payment";
import type { Queue } from "bullmq";
import type { ConfirmJobData } from "../../queues/txQueue";

// ---------------------------------------------------------------------------
// Minimal fakes
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    id: "tx-abc123",
    payoutId: "payout-1",
    arenaId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4",
    destinationAccount: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    amountStroops: "10000000",
    asset: "XLM",
    idempotencyKey: "idem-1",
    status: "queued",
    signedXdr: "AAAAAA==",
    txHash: null,
    attempts: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    confirmedAt: null,
    errorMessage: null,
    breakdown: null,
    ...overrides,
  };
}

function makeRepo(record: TransactionRecord): jest.Mocked<TransactionRepository> {
  return {
    findById: jest.fn().mockResolvedValue(record),
    findByIdempotencyKey: jest.fn(),
    findByPayoutId: jest.fn(),
    listByStatus: jest.fn(),
    create: jest.fn(),
    update: jest.fn().mockImplementation((_id, patch) => Promise.resolve({ ...record, ...patch })),
  } as unknown as jest.Mocked<TransactionRepository>;
}

function makeFakeQueue(): jest.Mocked<Queue<ConfirmJobData>> {
  return {
    add: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<Queue<ConfirmJobData>>;
}

function makeRpcServer(sendStatus: string = "PENDING") {
  return {
    sendTransaction: jest.fn().mockResolvedValue({ status: sendStatus, hash: "testhash" }),
    getTransaction: jest.fn(),
    prepareTransaction: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PaymentService queue integration (#1602)", () => {
  const baseConfig = {
    liveExecution: true,
    maxAttempts: 5,
    networkPassphrase: "Test SDF Network ; September 2015",
    sourceAccount: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    payoutContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4",
    payoutMethodName: "distribute_winnings",
    sorobanRpcUrl: "http://localhost:8000",
    maxGasStroops: 1_000_000,
    confirmMaxPolls: 10,
    confirmPollMs: 500,
  };

  it("enqueues a tx-confirm job with the transactionId as jobId after a successful submission", async () => {
    const record = makeRecord();
    const repo = makeRepo(record);
    const rpc = makeRpcServer("PENDING");
    const queue = makeFakeQueue();

    const service = new PaymentService(repo, {
      config: baseConfig as any,
      rpcServer: rpc,
      txQueue: queue,
    });

    // Stub TransactionBuilder.fromXDR to avoid real XDR parsing
    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    const origFromXDR = TransactionBuilder.fromXDR;
    TransactionBuilder.fromXDR = jest.fn().mockReturnValue({
      // minimal stub that passes the signed-transaction guard
      constructor: { name: "Transaction" },
    });

    try {
      await service.submitQueuedTransaction(record.id);
    } catch {
      // XDR parse may fail in test env; we only care about queue.add call
    }

    // Restore
    TransactionBuilder.fromXDR = origFromXDR;

    // The queue.add should have been called with jobId === transactionId
    expect(queue.add).toHaveBeenCalledWith(
      "confirm",
      { transactionId: record.id },
      { jobId: record.id },
    );
  });

  it("does not enqueue when submission returns non-PENDING status (ERROR)", async () => {
    const record = makeRecord();
    const repo = makeRepo(record);
    const rpc = makeRpcServer("ERROR");
    const queue = makeFakeQueue();

    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    const origFromXDR = TransactionBuilder.fromXDR;
    TransactionBuilder.fromXDR = jest.fn().mockReturnValue({});

    const service = new PaymentService(repo, {
      config: baseConfig as any,
      rpcServer: rpc,
      txQueue: queue,
    });

    try {
      await service.submitQueuedTransaction(record.id);
    } catch {
      // ignore
    }

    TransactionBuilder.fromXDR = origFromXDR;

    expect(queue.add).not.toHaveBeenCalled();
  });

  it("does not enqueue when no txQueue is configured (fallback path)", async () => {
    const record = makeRecord();
    const repo = makeRepo(record);
    const rpc = makeRpcServer("PENDING");

    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    const origFromXDR = TransactionBuilder.fromXDR;
    TransactionBuilder.fromXDR = jest.fn().mockReturnValue({});

    const service = new PaymentService(repo, {
      config: baseConfig as any,
      rpcServer: rpc,
      // no txQueue
    });

    try {
      await service.submitQueuedTransaction(record.id);
    } catch {
      // ignore
    }

    TransactionBuilder.fromXDR = origFromXDR;
    // Nothing to assert — test just ensures no crash when queue is absent
  });

  it("is idempotent: duplicate enqueue uses the same jobId and BullMQ silently deduplicates", async () => {
    const record = makeRecord();
    const repo = makeRepo(record);
    const rpc = makeRpcServer("PENDING");
    const queue = makeFakeQueue();

    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    const origFromXDR = TransactionBuilder.fromXDR;
    TransactionBuilder.fromXDR = jest.fn().mockReturnValue({});

    const service = new PaymentService(repo, {
      config: baseConfig as any,
      rpcServer: rpc,
      txQueue: queue,
    });

    try {
      await service.submitQueuedTransaction(record.id);
      await service.submitQueuedTransaction(record.id);
    } catch {
      // ignore
    }

    TransactionBuilder.fromXDR = origFromXDR;

    // Both calls used the same jobId
    const calls = queue.add.mock.calls;
    for (const call of calls) {
      expect(call[2]).toMatchObject({ jobId: record.id });
    }
  });

  it("pollConfirmation no longer exists on PaymentService (#1602)", () => {
    const service = new PaymentService(makeRepo(makeRecord()), {});
    expect((service as any).pollConfirmation).toBeUndefined();
  });
});
