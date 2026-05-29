/**
 * Jest unit tests for PaymentService covering:
 *  - signed-XDR source/destination/amount/contract audit before queuing (#667)
 *  - the transaction status machine with a stubbed RPC server (#681)
 *
 * (The existing payment.unit.test.ts uses the node:test runner; these are the
 * jest-based additions requested by #681.)
 */
import {
  Account,
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";
import { PaymentService } from "../src/services/paymentService";
import { InMemoryTransactionRepository } from "../src/repositories/inMemoryTransactionRepository";
import type { PaymentConfig } from "../src/config/paymentConfig";

const SOURCE = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const DEST_A = Keypair.random().publicKey();
const DEST_B = Keypair.random().publicKey();
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const PASSPHRASE = "Test SDF Network ; September 2015";

function makeConfig(): PaymentConfig {
  return {
    liveExecution: true,
    signWithHotKey: false,
    maxGasStroops: 2_000_000,
    maxAttempts: 5,
    confirmPollMs: 1,
    confirmMaxPolls: 3,
    payoutMethodName: "distribute_winnings",
    payoutContractId: CONTRACT,
    sourceAccount: SOURCE,
    hotSignerSecret: undefined,
    networkPassphrase: PASSPHRASE,
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
  } as PaymentConfig;
}

function makeRpc(overrides: Record<string, unknown> = {}) {
  return {
    getAccount: jest.fn(async () => new Account(SOURCE, "1")),
    prepareTransaction: jest.fn(async (tx: { toXDR: () => string }) => ({
      fee: "100",
      toXDR: () => tx.toXDR(),
      sign: () => {},
    })),
    sendTransaction: jest.fn(async () => ({ status: "PENDING", hash: "tx-hash" })),
    getTransaction: jest.fn(async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS })),
    ...overrides,
  };
}

function makeService(rpcServer: ReturnType<typeof makeRpc>) {
  const repo = new InMemoryTransactionRepository();
  const service = new PaymentService(repo, { config: makeConfig(), rpcServer: rpcServer as never });
  return { service, repo };
}

async function createAndSign(
  service: PaymentService,
  dest: string,
  amount: string,
  idem: string,
) {
  const built = await service.createPayoutTransaction({
    payoutId: `p-${idem}`,
    destinationAccount: dest,
    amount,
    asset: "XLM",
    idempotencyKey: idem,
  });
  const tx = TransactionBuilder.fromXDR(built.unsignedXdr!, PASSPHRASE);
  tx.sign(Keypair.random());
  return { id: built.transaction.id, signedXdr: tx.toXDR() };
}

describe("PaymentService signed-XDR audit (#667)", () => {
  it("queues a signed transaction that matches the payout record", async () => {
    const { service } = makeService(makeRpc());
    const { id, signedXdr } = await createAndSign(service, DEST_A, "10", "idem-ok-0001");

    const result = await service.queueSignedTransaction(id, signedXdr);
    expect(result.status).toBe("queued");
    expect(result.signedXdr).toBe(signedXdr);
  });

  it("rejects an unparseable signed XDR", async () => {
    const { service } = makeService(makeRpc());
    const { id } = await createAndSign(service, DEST_A, "10", "idem-bad-0002");
    await expect(service.queueSignedTransaction(id, "not-valid-xdr")).rejects.toThrow(/parsed/i);
  });

  it("rejects a transaction whose destination was swapped", async () => {
    const { service } = makeService(makeRpc());
    // Record #1 is for DEST_A; the signer returns a tx paying DEST_B.
    const rec = await service.createPayoutTransaction({
      payoutId: "p-dest",
      destinationAccount: DEST_A,
      amount: "10",
      asset: "XLM",
      idempotencyKey: "idem-dest-0003",
    });
    const malicious = await createAndSign(service, DEST_B, "10", "idem-dest-0004");
    await expect(
      service.queueSignedTransaction(rec.transaction.id, malicious.signedXdr),
    ).rejects.toThrow(/destination/i);
  });

  it("rejects a transaction whose amount was altered", async () => {
    const { service } = makeService(makeRpc());
    const rec = await service.createPayoutTransaction({
      payoutId: "p-amt",
      destinationAccount: DEST_A,
      amount: "10",
      asset: "XLM",
      idempotencyKey: "idem-amt-0005",
    });
    const malicious = await createAndSign(service, DEST_A, "999", "idem-amt-0006");
    await expect(
      service.queueSignedTransaction(rec.transaction.id, malicious.signedXdr),
    ).rejects.toThrow(/amount/i);
  });

  it("rejects a transaction signed for a different source account", async () => {
    const { service } = makeService(makeRpc());
    const { id } = await createAndSign(service, DEST_A, "10", "idem-src-0007");
    // A correctly-formed payout invocation, but built under a foreign source.
    const op = new Contract(CONTRACT).call(
      "distribute_winnings",
      new Address(DEST_A).toScVal(),
      nativeToScVal(BigInt("100000000"), { type: "i128" }),
      nativeToScVal("XLM"),
      nativeToScVal(BigInt(0), { type: "u64" }),
      nativeToScVal("p-src"),
    );
    const foreign = new TransactionBuilder(new Account(DEST_B, "5"), {
      fee: "100",
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(op)
      .setTimeout(60)
      .build();
    foreign.sign(Keypair.random());
    await expect(service.queueSignedTransaction(id, foreign.toXDR())).rejects.toThrow(/source/i);
  });
});

describe("PaymentService status machine (#681)", () => {
  let idemCounter = 0;
  async function queuedTransaction(service: PaymentService) {
    idemCounter += 1;
    const { id, signedXdr } = await createAndSign(
      service,
      DEST_A,
      "10",
      `idem-status-${idemCounter}0000`,
    );
    await service.queueSignedTransaction(id, signedXdr);
    return id;
  }

  it("built → queued → submitted on a PENDING send", async () => {
    const rpcServer = makeRpc();
    const { service } = makeService(rpcServer);
    const id = await queuedTransaction(service);

    const result = await service.submitQueuedTransaction(id);
    expect(result.submitted).toBe(true);
    expect(result.transaction.status).toBe("submitted");
    expect(result.transaction.txHash).toBe("tx-hash");
  });

  it("submitted → confirmed on a SUCCESS receipt", async () => {
    const rpcServer = makeRpc();
    const { service } = makeService(rpcServer);
    const id = await queuedTransaction(service);
    await service.submitQueuedTransaction(id);

    const confirmed = await service.confirmSubmittedTransaction(id);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.confirmedAt).toBeTruthy();
  });

  it("queued → failed when Soroban returns ERROR", async () => {
    const rpcServer = makeRpc({
      sendTransaction: jest.fn(async () => ({ status: "ERROR", hash: "h" })),
    });
    const { service } = makeService(rpcServer);
    const id = await queuedTransaction(service);

    const result = await service.submitQueuedTransaction(id);
    expect(result.submitted).toBe(false);
    expect(result.transaction.status).toBe("failed");
    expect(result.transaction.errorMessage).toMatch(/rejected/i);
  });

  it("stays queued when Soroban asks to TRY_AGAIN_LATER", async () => {
    const rpcServer = makeRpc({
      sendTransaction: jest.fn(async () => ({ status: "TRY_AGAIN_LATER", hash: "h" })),
    });
    const { service } = makeService(rpcServer);
    const id = await queuedTransaction(service);

    const result = await service.submitQueuedTransaction(id);
    expect(result.submitted).toBe(false);
    expect(result.transaction.status).toBe("queued");
    expect(result.transaction.attempts).toBe(1);
  });

  it("submitted → failed on a FAILED receipt", async () => {
    const rpcServer = makeRpc({
      getTransaction: jest.fn(async () => ({ status: rpc.Api.GetTransactionStatus.FAILED })),
    });
    const { service } = makeService(rpcServer);
    const id = await queuedTransaction(service);
    await service.submitQueuedTransaction(id);

    const confirmed = await service.confirmSubmittedTransaction(id);
    expect(confirmed.status).toBe("failed");
    expect(confirmed.errorMessage).toMatch(/on-chain/i);
  });
});
