/**
 * Soroban invoke operations and unsigned transaction assembly (#245).
 * Named “composer” here to avoid clashing with the SDK’s `TransactionBuilder` class.
 */
import { Account, Contract, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  encodeAddress,
  encodeAmount,
  encodeBytes32,
  encodeChoice,
  encodeRound,
} from "@/shared-d/utils/scval-helpers";
import type { CreatePoolParamsValidated } from "@/shared-d/utils/stellar-transaction-schemas";

type SorobanOperation = ReturnType<Contract["call"]>;

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
    operation: SorobanOperation;
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
): SorobanOperation {
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
): SorobanOperation {
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
): SorobanOperation {
  return stakingContract.call(
    "unstake",
    encodeAddress(stakerPublicKey),
    encodeAmount(sharesStroops),
  );
}

export function buildJoinCallOperation(poolContract: Contract): SorobanOperation {
  return poolContract.call("join");
}

/**
 * Commit phase (#1137): submit a blinded commitment
 * (`SHA256([choice_byte] ++ salt_32_bytes)`) without revealing the choice.
 * Matches `contract/arena/src/lib.rs`'s `submit_commitment(player, commitment)`.
 */
export function buildSubmitCommitmentOperation(
  poolContract: Contract,
  playerPublicKey: string,
  commitment: Uint8Array,
): SorobanOperation {
  return poolContract.call(
    "submit_commitment",
    encodeAddress(playerPublicKey),
    encodeBytes32(commitment),
  );
}

/**
 * Reveal phase (#1137): reveal the choice + salt committed earlier so the
 * contract can verify it against the stored commitment hash. Matches
 * `contract/arena/src/lib.rs`'s `reveal_choice(player, choice, salt)`.
 */
export function buildRevealChoiceOperation(
  poolContract: Contract,
  playerPublicKey: string,
  choice: "Heads" | "Tails",
  salt: Uint8Array,
): SorobanOperation {
  return poolContract.call(
    "reveal_choice",
    encodeAddress(playerPublicKey),
    encodeChoice(choice),
    encodeBytes32(salt),
  );
}

export function buildClaimCallOperation(poolContract: Contract): SorobanOperation {
  return poolContract.call("claim");
}

export function buildGetArenaStateCallOperation(
  arenaContract: Contract,
): SorobanOperation {
  return arenaContract.call("get_arena_state");
}

export function buildGetUserStateCallOperation(
  arenaContract: Contract,
  userPublicKey: string,
): SorobanOperation {
  return arenaContract.call(
    "get_user_state",
    encodeAddress(userPublicKey),
  );
}

export function buildGetFullStateCallOperation(
  arenaContract: Contract,
  userPublicKey: string,
): SorobanOperation {
  return arenaContract.call(
    "get_full_state",
    encodeAddress(userPublicKey),
  );
}
