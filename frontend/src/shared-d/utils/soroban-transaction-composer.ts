/**
 * Soroban invoke operations and unsigned transaction assembly (#245).
 * Named “composer” here to avoid clashing with the SDK’s `TransactionBuilder` class.
 */
import { Account, Contract, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
// SDK integration boundary: Operation2<InvokeHostFunction> from Contract.call() is
// structurally compatible with Operation but TypeScript's nominal check rejects it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyOperation = any;
import {
  encodeAddress,
  encodeAmount,
  encodeChoice,
  encodeRound,
} from "@/shared-d/utils/scval-helpers";
import type { CreatePoolParamsValidated } from "@/shared-d/utils/stellar-transaction-schemas";

/**
 * Assembles an unsigned {@link Transaction} with a single operation (Soroban / classic).
 * This is the transaction *assembly* layer — distinct from {@link TransactionBuilder} naming in the issue ticket.
 */
export function composeUnsignedTransaction(
  account: Account,
  options: {
    fee: string;
    networkPassphrase: string;
    timeout: number;
    operation: AnyOperation;
  },
): Transaction {
  return new TransactionBuilder(account, {
    fee: options.fee,
    networkPassphrase: options.networkPassphrase,
  })
    .addOperation(options.operation)
    .setTimeout(options.timeout)
    .build();
}

export function roundSpeedToSeconds(
  roundSpeed: CreatePoolParamsValidated["roundSpeed"],
): number {
  if (roundSpeed === "30S") return 30;
  if (roundSpeed === "1M") return 60;
  return 300;
}

export function buildCreatePoolCallOperation(
  factory: Contract,
  params: CreatePoolParamsValidated,
  tokenContractIds: { xlmContractId: string; usdcContractId: string },
): AnyOperation {
  const amountBigInt = BigInt(Math.floor(params.stakeAmount * 10_000_000));
  const currencyContractId =
    params.currency === "USDC"
      ? tokenContractIds.usdcContractId
      : tokenContractIds.xlmContractId;
  const roundSpeedSeconds = roundSpeedToSeconds(params.roundSpeed);

  const args = [
    encodeAmount(amountBigInt),
    encodeAddress(currencyContractId),
    encodeRound(roundSpeedSeconds),
    encodeRound(params.arenaCapacity),
  ];

  return factory.call("create_pool", ...args);
}

export function buildStakeCallOperation(
  stakingContract: Contract,
  amountStroops: bigint,
  stakerPublicKey: string,
): AnyOperation {
  return stakingContract.call(
    "stake",
    encodeAddress(stakerPublicKey),
    encodeAmount(amountStroops),
  );
}

export function buildUnstakeCallOperation(
  stakingContract: Contract,
  sharesStroops: bigint,
  stakerPublicKey: string,
): AnyOperation {
  return stakingContract.call(
    "unstake",
    encodeAddress(stakerPublicKey),
    encodeAmount(sharesStroops),
  );
}

export function buildJoinCallOperation(poolContract: Contract): AnyOperation {
  return poolContract.call("join");
}

export function buildSubmitChoiceCallOperation(
  poolContract: Contract,
  roundNumber: number,
  choice: "Heads" | "Tails",
): AnyOperation {
  return poolContract.call(
    "submit_choice",
    encodeRound(roundNumber),
    encodeChoice(choice),
  );
}

export function buildClaimCallOperation(poolContract: Contract): AnyOperation {
  return poolContract.call("claim");
}

export function buildGetArenaStateCallOperation(
  arenaContract: Contract,
): AnyOperation {
  return arenaContract.call("get_arena_state");
}

export function buildGetUserStateCallOperation(
  arenaContract: Contract,
  userPublicKey: string,
): AnyOperation {
  return arenaContract.call(
    "get_user_state",
    encodeAddress(userPublicKey),
  );
}

export function buildGetFullStateCallOperation(
  arenaContract: Contract,
  userPublicKey: string,
): AnyOperation {
  return arenaContract.call(
    "get_full_state",
    encodeAddress(userPublicKey),
  );
}
