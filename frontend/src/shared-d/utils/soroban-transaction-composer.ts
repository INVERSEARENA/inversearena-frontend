/**
 * Soroban invoke operations and unsigned transaction assembly (#245).
 * Named “composer” here to avoid clashing with the SDK’s `TransactionBuilder` class.
 */
import { Account, Contract, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import type { Operation } from "@stellar/stellar-sdk";
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
    operation: Operation;
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
  publicKey: string,
  params: CreatePoolParamsValidated,
  tokenContractIds: { xlmContractId: string; usdcContractId: string },
): Operation {
  const amountBigInt = BigInt(Math.floor(params.stakeAmount * 10_000_000));
  const currencyContractId =
    params.currency === "USDC"
      ? tokenContractIds.usdcContractId
      : tokenContractIds.xlmContractId;
  const roundSpeedSeconds = roundSpeedToSeconds(params.roundSpeed);

  const args = [
    encodeAddress(publicKey),
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
): Operation {
  return stakingContract.call(
    "stake",
    encodeAddress(stakerPublicKey),
    encodeAmount(amountStroops),
  );
}

export function buildJoinCallOperation(
  poolContract: Contract,
  publicKey: string,
): Operation {
  return poolContract.call("join", encodeAddress(publicKey));
}

export function buildSubmitChoiceCallOperation(
  poolContract: Contract,
  roundNumber: number,
  choice: "Heads" | "Tails",
): Operation {
  return poolContract.call(
    "submit_choice",
    encodeRound(roundNumber),
    encodeChoice(choice),
  );
}

export function buildClaimCallOperation(
  poolContract: Contract,
  publicKey: string,
): Operation {
  return poolContract.call("claim", encodeAddress(publicKey));
}

export function buildGetArenaStateCallOperation(
  arenaContract: Contract,
): Operation {
  return arenaContract.call("get_arena_state");
}

export function buildGetUserStateCallOperation(
  arenaContract: Contract,
  userPublicKey: string,
): Operation {
  return arenaContract.call(
    "get_user_state",
    encodeAddress(userPublicKey),
  );
}
