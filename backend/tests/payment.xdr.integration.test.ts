/**
 * Integration test: XDR produced by buildPreparedTransaction matches the
 * distribute_winnings contract ABI (#1149).
 *
 * Uses a stub RPC server that echoes the transaction back (simulating a local
 * Soroban sandbox accepting the XDR) so the test catches argument-count and
 * argument-type mismatches without requiring a live network.
 *
 * Verified invariants:
 *   1. The transaction contains exactly one Soroban invoke-contract operation.
 *   2. The invoked function is `distribute_winnings`.
 *   3. The argument list has exactly 3 entries (payout_id: u64, winner: Address, amount: i128).
 *   4. arg[0] decodes to a BigInt (u64 payout ID).
 *   5. arg[1] decodes to the expected destination account address.
 *   6. arg[2] decodes to the expected amount in stroops (i128).
 */

import {
  Account,
  Address,
  Keypair,
  TransactionBuilder,
  scValToNative,
  xdr,
  rpc,
} from "@stellar/stellar-sdk";
import { PaymentService } from "../src/services/paymentService";
import { InMemoryTransactionRepository } from "../src/repositories/inMemoryTransactionRepository";
import type { PaymentConfig } from "../src/config/paymentConfig";
import { resetSorobanBreakerForTest } from "../src/utils/circuitBreaker";

const PASSPHRASE = "Test SDF Network ; September 2015";
const SOURCE = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const DEST = Keypair.random().publicKey();
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

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

/**
 * Stub RPC that records the last prepared transaction XDR so tests can decode it.
 * prepareTransaction echoes the input back (simulating sandbox acceptance).
 */
function makeSandboxRpc() {
  let lastXdr: string | null = null;

  const rpcServer = {
    getAccount: jest.fn(async () => new Account(SOURCE, "1")),
    prepareTransaction: jest.fn(async (tx: { toXDR: () => string }) => {
      lastXdr = tx.toXDR();
      return {
        fee: "100",
        toXDR: () => lastXdr as string,
        sign: () => {},
      };
    }),
    sendTransaction: jest.fn(async () => ({ status: "PENDING", hash: "tx-hash-xdr-test" })),
    getTransaction: jest.fn(async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS })),
  };

  return {
    rpcServer,
    getLastXdr: () => lastXdr,
  };
}

afterAll(() => {
  resetSorobanBreakerForTest();
});

describe("buildPreparedTransaction XDR matches distribute_winnings ABI (#1149)", () => {
  it("produces a single invoke-contract operation targeting the payout contract", async () => {
    const { rpcServer, getLastXdr } = makeSandboxRpc();
    const repo = new InMemoryTransactionRepository();
    const service = new PaymentService(repo, {
      config: makeConfig(),
      rpcServer: rpcServer as never,
    });

    await service.createPayoutTransaction({
      payoutId: "42",
      destinationAccount: DEST,
      amount: "100",
      asset: "XLM",
      idempotencyKey: "xdr-integration-test-001",
    });

    const rawXdr = getLastXdr();
    expect(rawXdr).not.toBeNull();

    // Decode the XDR produced by buildPreparedTransaction.
    const tx = TransactionBuilder.fromXDR(rawXdr!, PASSPHRASE);
    const ops = tx.operations;
    expect(ops).toHaveLength(1);

    const op = ops[0]!;
    expect(op.type).toBe("invokeHostFunction");

    const invokeOp = op as { type: string; func: xdr.HostFunction };
    const hostFn = invokeOp.func;
    expect(hostFn.switch().name).toBe("hostFunctionTypeInvokeContract");

    const invokeArgs = hostFn.invokeContract();
    const contractAddress = Address.fromScAddress(invokeArgs.contractAddress()).toString();
    expect(contractAddress).toBe(CONTRACT);

    const fnName = invokeArgs.functionName().toString();
    expect(fnName).toBe("distribute_winnings");

    const args = invokeArgs.args();
    expect(args).toHaveLength(3);

    // arg[0]: payout_id — must be a u64 BigInt
    const payoutId = scValToNative(args[0]!);
    expect(typeof payoutId).toBe("bigint");
    expect(payoutId).toBe(42n);

    // arg[1]: winner address — must decode to the destination account
    const winner = Address.fromScVal(args[1]!).toString();
    expect(winner).toBe(DEST);

    // arg[2]: amount — must be a bigint equal to amount × 10_000_000 (stroops)
    const amount = scValToNative(args[2]!);
    expect(typeof amount).toBe("bigint");
    expect(amount).toBe(1_000_000_000n); // 100 XLM = 100 * 10_000_000 stroops
  });

  it("argument count is exactly 3 — catches ABI arity mismatches", async () => {
    const { rpcServer, getLastXdr } = makeSandboxRpc();
    const repo = new InMemoryTransactionRepository();
    const service = new PaymentService(repo, {
      config: makeConfig(),
      rpcServer: rpcServer as never,
    });

    await service.createPayoutTransaction({
      payoutId: "99",
      destinationAccount: DEST,
      amount: "1",
      asset: "XLM",
      idempotencyKey: "xdr-integration-test-002",
    });

    const tx = TransactionBuilder.fromXDR(getLastXdr()!, PASSPHRASE);
    const op = tx.operations[0] as { func: xdr.HostFunction };
    const argCount = op.func.invokeContract().args().length;

    // distribute_winnings ABI: (payout_id: u64, winner: Address, amount: i128) — 3 args.
    // If this fails the backend builder and the contract ABI are out of sync.
    expect(argCount).toBe(3);
  });
});
