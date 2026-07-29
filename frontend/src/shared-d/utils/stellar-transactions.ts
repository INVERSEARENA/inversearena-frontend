/**
 * Stellar / Soroban orchestration for Inverse Arena.
 *
 * Split per #245: `contract-client-factory`, `horizon-account-loader`,
 * `stellar-fee-estimator`, and `soroban-transaction-composer`.
 */
import { Account, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  PositiveAmountSchema,
  RoundChoiceSchema,
  RoundNumberSchema,
  SignedXdrSchema,
  StellarContractIdSchema,
  StellarPublicKeySchema,
} from "@/shared-d/utils/security-validation";
import {
} from "@/components/hook-d/arenaConstants";
import { STELLAR_PLACEHOLDERS, stellarConfig } from "@/lib/stellarConfig";

// Re-export for use in components
export { STELLAR_PLACEHOLDERS };
import {
  ContractError,
  ContractErrorCode,
  parseContractError,
} from "@/shared-d/utils/contract-error";
import { ContractClientFactory } from "@/shared-d/utils/contract-client-factory";
import {
  HorizonAccountFetchError,
  loadAccountFromHorizon,
} from "@/shared-d/utils/horizon-account-loader";
import {
  getDefaultInvokeBaseFee,
  getInfiniteTimeout,
  getJoinArenaFee,
  getShortTxTimeoutSeconds,
  getStandardTxTimeoutSeconds,
  getSubmitRetryConfig,
} from "@/shared-d/utils/stellar-fee-estimator";
import {
  buildClaimCallOperation,
  buildCreatePoolCallOperation,
  buildGetFullStateCallOperation,
  buildJoinCallOperation,
  buildRevealChoiceOperation,
  buildStakeCallOperation,
  buildSubmitCommitmentOperation,
  buildUnstakeCallOperation,
  composeUnsignedTransaction,
} from "@/shared-d/utils/soroban-transaction-composer";
import { CreatePoolParamsSchema } from "@/shared-d/utils/stellar-transaction-schemas";
import {
  extractBoolFromScVal,
  extractI128FromScVal,
  extractU32FromScVal,
  stroopsToDisplayAmount,
} from "@/shared-d/utils/stellar-scval-extract";
import {
  clearCommitment,
  computeCommitment,
  generateSalt,
  loadCommitment,
  saveCommitment,
} from "@/shared-d/utils/commit-reveal";

// Re-export so consumers can import from one place
export { ContractError, ContractErrorCode, parseContractError } from "@/shared-d/utils/contract-error";

export { ContractClientFactory } from "@/shared-d/utils/contract-client-factory";
export type { ContractClientFactoryDeps } from "@/shared-d/utils/contract-client-factory";

export const FACTORY_CONTRACT_ID = stellarConfig.factoryContractId;
export const XLM_CONTRACT_ID = stellarConfig.xlmContractId;
export const USDC_CONTRACT_ID = stellarConfig.usdcContractId;
export const STAKING_CONTRACT_ID =
  stellarConfig.stakingContractId ?? STELLAR_PLACEHOLDERS.stakingContractId;

export const NETWORK_PASSPHRASE = stellarConfig.passphrase;
export const HORIZON_URL = stellarConfig.horizonUrl;
export const SOROBAN_RPC_URL = stellarConfig.sorobanRpcUrl;

const defaultSorobanClients = new ContractClientFactory(SOROBAN_RPC_URL);

/**
 * Orchestration: Horizon account load + {@link ContractError} mapping.
 * Low-level fetch lives in {@link loadAccountFromHorizon}.
 */
async function getAccount(publicKey: string, fn: string): Promise<Account> {
  try {
    const validatedPublicKey = StellarPublicKeySchema.parse(publicKey);
    return await loadAccountFromHorizon(HORIZON_URL, validatedPublicKey);
  } catch (error) {
    if (error instanceof HorizonAccountFetchError) {
      throw new ContractError({
        code: ContractErrorCode.ACCOUNT_NOT_FOUND,
        fn,
      });
    }
    throw parseContractError(error, fn);
  }
}

/**
 * Build a transaction to create a new pool using the Factory contract.
 */
export async function buildCreatePoolTransaction(
  publicKey: string,
  params: {
    stakeAmount: number;
    currency: string;
    roundSpeed: string;
    arenaCapacity: number;
  },
) {
  const FN = "buildCreatePoolTransaction";
  try {
    const validatedParams = CreatePoolParamsSchema.parse(params);
    const account = await getAccount(publicKey, FN);
    const factory = defaultSorobanClients.createContract(FACTORY_CONTRACT_ID);

    const operation = buildCreatePoolCallOperation(factory, validatedParams, {
      xlmContractId: XLM_CONTRACT_ID,
      usdcContractId: USDC_CONTRACT_ID,
    }, publicKey);

    return composeUnsignedTransaction(account, {
      fee: getDefaultInvokeBaseFee(),
      networkPassphrase: NETWORK_PASSPHRASE,
      timeout: getInfiniteTimeout(),
      operation,
    });
  } catch (error) {
    throw parseContractError(error, FN);
  }
}

/**
 * Build an unsigned transaction to stake XLM via the protocol contract.
 * Uses Soroban prepareTransaction for correct footprint and fees.
 */
export async function buildStakeProtocolTransaction(
  publicKey: string,
  amount: number,
) {
  const FN = "buildStakeProtocolTransaction";
  try {
    const validatedPublicKey = StellarPublicKeySchema.parse(publicKey);
    const validatedAmount = PositiveAmountSchema.parse(amount);

    if (
      !STAKING_CONTRACT_ID ||
      STAKING_CONTRACT_ID === STELLAR_PLACEHOLDERS.stakingContractId ||
      STAKING_CONTRACT_ID.includes("...")
    ) {
      throw new ContractError({
        code: ContractErrorCode.CONFIG_MISSING,
        message:
          "Staking contract not configured. Add NEXT_PUBLIC_STAKING_CONTRACT_ID to .env.local with your Soroban contract address.",
        fn: FN,
      });
    }

    const server = defaultSorobanClients.createRpcServer();
    const account = await getAccount(validatedPublicKey, FN);
    const stakingContract = defaultSorobanClients.createContract(
      STAKING_CONTRACT_ID,
    );

    const amountStroops = BigInt(Math.floor(validatedAmount * 10_000_000));
    const operation = buildStakeCallOperation(
      stakingContract,
      amountStroops,
      validatedPublicKey,
    );

    const builtTx = composeUnsignedTransaction(account, {
      fee: getDefaultInvokeBaseFee(),
      networkPassphrase: NETWORK_PASSPHRASE,
      timeout: getInfiniteTimeout(),
      operation,
    });

    return server.prepareTransaction(builtTx);
  } catch (error) {
    throw parseContractError(error, FN);
  }
}

/**
 * Build an unsigned transaction to unstake shares via the protocol contract.
 * Uses Soroban prepareTransaction for correct footprint and fees.
 */
export async function buildUnstakeProtocolTransaction(
  publicKey: string,
  shares: number,
) {
  const FN = "buildUnstakeProtocolTransaction";
  try {
    const validatedPublicKey = StellarPublicKeySchema.parse(publicKey);
    const validatedShares = PositiveAmountSchema.parse(shares);

    if (
      !STAKING_CONTRACT_ID ||
      STAKING_CONTRACT_ID === STELLAR_PLACEHOLDERS.stakingContractId ||
      STAKING_CONTRACT_ID.includes("...")
    ) {
      throw new ContractError({
        code: ContractErrorCode.CONFIG_MISSING,
        message:
          "Staking contract not configured. Add NEXT_PUBLIC_STAKING_CONTRACT_ID to .env.local with your Soroban contract address.",
        fn: FN,
      });
    }

    const server = defaultSorobanClients.createRpcServer();
    const account = await getAccount(validatedPublicKey, FN);
    const stakingContract = defaultSorobanClients.createContract(
      STAKING_CONTRACT_ID,
    );

    const sharesStroops = BigInt(Math.floor(validatedShares * 10_000_000));
    const operation = buildUnstakeCallOperation(
      stakingContract,
      sharesStroops,
      validatedPublicKey,
    );

    const builtTx = composeUnsignedTransaction(account, {
      fee: getDefaultInvokeBaseFee(),
      networkPassphrase: NETWORK_PASSPHRASE,
      timeout: getInfiniteTimeout(),
      operation,
    });

    return server.prepareTransaction(builtTx);
  } catch (error) {
    throw parseContractError(error, FN);
  }
}

/**
 * Build transaction to join an arena.
 */
export async function buildJoinArenaTransaction(
  publicKey: string,
  poolId: string,
  amount: number,
) {
  const FN = "buildJoinArenaTransaction";
  try {
    const validatedPublicKey = StellarPublicKeySchema.parse(publicKey);
    const validatedPoolId = StellarContractIdSchema.parse(poolId);
    PositiveAmountSchema.parse(amount);

    const account = await getAccount(validatedPublicKey, FN);
    const poolContract = defaultSorobanClients.createContract(validatedPoolId);
    const operation = buildJoinCallOperation(poolContract, validatedPublicKey);

    return composeUnsignedTransaction(account, {
      fee: getJoinArenaFee(),
      networkPassphrase: NETWORK_PASSPHRASE,
      timeout: getStandardTxTimeoutSeconds(),
      operation,
    });
  } catch (error) {
    throw parseContractError(error, FN);
  }
}

/**
 * Commit phase (#1137): generate a random salt, compute
 * `SHA256([choice_byte] ++ salt)` client-side (WebCrypto), persist
 * `{ choice, salt }` in localStorage keyed by arena + round (needed again at
 * reveal time — the salt is never sent on-chain here), and build the
 * `submit_commitment` transaction carrying only the hash.
 */
export async function buildSubmitCommitmentTransaction(
  publicKey: string,
  poolId: string,
  choice: "Heads" | "Tails",
  roundNumber: number,
) {
  const FN = "buildSubmitCommitmentTransaction";
  try {
    const validatedPublicKey = StellarPublicKeySchema.parse(publicKey);
    const validatedPoolId = StellarContractIdSchema.parse(poolId);
    const validatedChoice = RoundChoiceSchema.parse(choice);
    const validatedRoundNumber = RoundNumberSchema.parse(roundNumber);

    const salt = generateSalt();
    const commitment = await computeCommitment(validatedChoice, salt);
    saveCommitment(validatedPoolId, validatedRoundNumber, {
      choice: validatedChoice,
      salt,
    });

    const account = await getAccount(validatedPublicKey, FN);
    const poolContract = defaultSorobanClients.createContract(validatedPoolId);
    const operation = buildSubmitCommitmentOperation(
      poolContract,
      validatedPublicKey,
      commitment,
    );

    return composeUnsignedTransaction(account, {
      fee: getDefaultInvokeBaseFee(),
      networkPassphrase: NETWORK_PASSPHRASE,
      timeout: getStandardTxTimeoutSeconds(),
      operation,
    });
  } catch (error) {
    throw parseContractError(error, FN);
  }
}

/**
 * Reveal phase (#1137): retrieve the `{ choice, salt }` saved during the
 * commit phase for this arena + round and build the `reveal_choice`
 * transaction. Throws VALIDATION_FAILED if nothing was committed on this
 * device for this round — there is no other source for the salt.
 *
 * Callers should only call {@link clearCommitmentForRound} once the reveal
 * transaction has actually been confirmed (see submitSignedTransaction) —
 * clearing it earlier would strand the only copy of the salt if signing is
 * cancelled or submission fails.
 */
export async function buildRevealChoiceTransaction(
  publicKey: string,
  poolId: string,
  roundNumber: number,
) {
  const FN = "buildRevealChoiceTransaction";
  try {
    const validatedPublicKey = StellarPublicKeySchema.parse(publicKey);
    const validatedPoolId = StellarContractIdSchema.parse(poolId);
    const validatedRoundNumber = RoundNumberSchema.parse(roundNumber);

    const stored = loadCommitment(validatedPoolId, validatedRoundNumber);
    if (!stored) {
      throw new ContractError({
        code: ContractErrorCode.VALIDATION_FAILED,
        message:
          "No commitment found for this round on this device — cannot reveal a choice that was never committed here.",
        fn: FN,
      });
    }

    const account = await getAccount(validatedPublicKey, FN);
    const poolContract = defaultSorobanClients.createContract(validatedPoolId);
    const operation = buildRevealChoiceOperation(
      poolContract,
      validatedPublicKey,
      stored.choice,
      stored.salt,
    );

    return composeUnsignedTransaction(account, {
      fee: getDefaultInvokeBaseFee(),
      networkPassphrase: NETWORK_PASSPHRASE,
      timeout: getStandardTxTimeoutSeconds(),
      operation,
    });
  } catch (error) {
    throw parseContractError(error, FN);
  }
}

/** Re-exported so callers can clear a round's stored commitment after a confirmed reveal (#1137). */
export function clearCommitmentForRound(poolId: string, roundNumber: number): void {
  clearCommitment(poolId, roundNumber);
}

/** True if this device has a stored commitment for the round — i.e. reveal is possible (#1137). */
export function hasStoredCommitmentForRound(poolId: string, roundNumber: number): boolean {
  return loadCommitment(poolId, roundNumber) !== null;
}

/**
 * Claim winnings.
 */
export async function buildClaimWinningsTransaction(
  publicKey: string,
  poolId: string,
) {
  const FN = "buildClaimWinningsTransaction";
  try {
    const validatedPublicKey = StellarPublicKeySchema.parse(publicKey);
    const validatedPoolId = StellarContractIdSchema.parse(poolId);

    const arenaState = await fetchArenaState(validatedPoolId, validatedPublicKey);
    if (!arenaState.hasWon) {
      throw new ContractError({
        code: ContractErrorCode.VALIDATION_FAILED,
        message:
          "Only the arena winner can claim winnings. This account is not the winner.",
        fn: FN,
      });
    }

    const account = await getAccount(validatedPublicKey, FN);
    const poolContract = defaultSorobanClients.createContract(validatedPoolId);
    const operation = buildClaimCallOperation(poolContract, validatedPublicKey);

    return composeUnsignedTransaction(account, {
      fee: getDefaultInvokeBaseFee(),
      networkPassphrase: NETWORK_PASSPHRASE,
      timeout: getShortTxTimeoutSeconds(),
      operation,
    });
  } catch (error) {
    throw parseContractError(error, FN);
  }
}

/**
 * Parse Stellar / Soroban errors for display in the UI.
 *
 * Delegates to `parseContractError` so copy stays aligned with
 * `contract/ERRORS.md` and `DEFAULT_MESSAGES` in `contract-error.ts`.
 * On-chain numeric codes are resolved via `contract-error-registry.ts`.
 */
export function parseStellarError(error: unknown): string {
  if (error instanceof ContractError) {
    return error.message;
  }
  return parseContractError(error, "parseStellarError").message;
}

/**
 * Arena state response type
 */
export interface ArenaStateResponse {
  arenaId: string;
  survivorsCount: number;
  maxCapacity: number;
  isUserIn: boolean;
  hasWon: boolean;
  currentStake: number;
  potentialPayout: number;
  roundNumber: number;
  gameState: number;
  entryFee: number;
  playerCount: number;
  commitDeadline: number | null;
  revealDeadline: number | null;
}

/**
 * Fetch the latest arena state from the contract.
 * Queries the Soroban arena contract for live state data.
 */
export async function fetchArenaState(
  arenaId: string,
  userAddress?: string,
): Promise<ArenaStateResponse> {
  const FN = "fetchArenaState";
  try {
    const validatedArenaId = StellarContractIdSchema.parse(arenaId);
    const validatedUserAddress = userAddress
      ? StellarPublicKeySchema.parse(userAddress)
      : undefined;

    const server = defaultSorobanClients.createRpcServer();
    const arenaContract = defaultSorobanClients.createContract(validatedArenaId);

    const dummyAccount = new Account(
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      "0",
    );

    const stateReaderAddress =
      validatedUserAddress ||
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

    const getStateOperation = buildGetFullStateCallOperation(
      arenaContract,
      stateReaderAddress,
    );
    const stateTx = composeUnsignedTransaction(dummyAccount, {
      fee: getDefaultInvokeBaseFee(),
      networkPassphrase: NETWORK_PASSPHRASE,
      timeout: getShortTxTimeoutSeconds(),
      operation: getStateOperation,
    });

    const stateSimulation = await server.simulateTransaction(stateTx);

    if (
      "error" in stateSimulation ||
      !("result" in stateSimulation) ||
      !stateSimulation.result ||
      stateSimulation.result.retval === undefined
    ) {
      const errorMsg =
        "error" in stateSimulation ? stateSimulation.error : "Unknown error";
      throw new ContractError({
        code: ContractErrorCode.SIMULATION_FAILED,
        message: `Failed to fetch arena state: ${errorMsg}`,
        fn: FN,
      });
    }

    const stateData = stateSimulation.result.retval;

    const survivorsCount =
      extractU32FromScVal(stateData, "survivors_count") || 0;
    const maxCapacity = extractU32FromScVal(stateData, "max_capacity") || 0;
    const roundNumber = extractU32FromScVal(stateData, "round_number") || 0;
    const currentStakeStroops =
      extractI128FromScVal(stateData, "current_stake") ?? 0n;
    const potentialPayout =
      extractI128FromScVal(stateData, "potential_payout") ?? 0n;
    const isUserIn = extractBoolFromScVal(stateData, "is_active") || false;
    const hasWon = extractBoolFromScVal(stateData, "has_won") || false;

    // entry_fee, player_count, and game_state aren't part of get_full_state's
    // return value yet (contract follow-up). Previously these were fetched via
    // three extra simulateTransaction calls to get_config/get_player_count/
    // game_state, which defeated the point of consolidating into one
    // get_full_state RPC call (and call sites that raced ahead of that
    // contract support just errored). Falling back to sane in-memory
    // defaults here keeps this a single round trip.
    const entryFeeStroops = 0n;
    const playerCount = survivorsCount;
    const gameState = 0;

    return {
      arenaId: validatedArenaId,
      survivorsCount,
      maxCapacity,
      isUserIn,
      hasWon,
      currentStake: stroopsToDisplayAmount(currentStakeStroops),
      potentialPayout: stroopsToDisplayAmount(potentialPayout),
      roundNumber,
      gameState,
      entryFee: stroopsToDisplayAmount(entryFeeStroops),
      playerCount,
      commitDeadline: null,
      revealDeadline: null,
    };
  } catch (error) {
    throw parseContractError(error, FN);
  }
}

/**
 * Submit a signed transaction to the network.
 */
export async function submitSignedTransaction(signedXdr: string) {
  const FN = "submitSignedTransaction";
  try {
    const validatedSignedXdr = SignedXdrSchema.parse(signedXdr);
    const server = defaultSorobanClients.createRpcServer();

    const tx = TransactionBuilder.fromXDR(
      validatedSignedXdr,
      NETWORK_PASSPHRASE,
    );
    const response = await server.sendTransaction(tx);

    if (response.status !== "PENDING") {
      throw new ContractError({
        code: ContractErrorCode.TRANSACTION_FAILED,
        message: `Transaction rejected by network: ${response.status}`,
        fn: FN,
      });
    }

    const hash = response.hash;
    let getTxResponse: Awaited<
      ReturnType<(typeof server)["getTransaction"]>
    > | undefined;

    const { maxRetries, retryIntervalMs } = getSubmitRetryConfig();
    let retries = 0;

    while (retries < maxRetries) {
      await new Promise((resolve) =>
        setTimeout(resolve, retryIntervalMs),
      );
      try {
        getTxResponse = await server.getTransaction(hash);
        if (getTxResponse.status !== "NOT_FOUND") {
          break;
        }
      } catch {
        // Ignore transient fetch failures while polling.
      }
      retries++;
    }

    // Soroban RPC's getTransaction() polling window is short, and a
    // transaction can still land on-chain after this loop gives up. NOT_FOUND
    // (still pending after every retry) and a total polling failure (every
    // attempt threw) both mean "unknown," never a hard failure — #1135:
    // showing TRANSACTION_FAILED here previously told users a transaction had
    // failed when it may well have succeeded a moment later. Any other
    // terminal status (e.g. an on-chain FAILED) is a genuine failure.
    if (!getTxResponse || getTxResponse.status === "NOT_FOUND") {
      throw new ContractError({
        code: ContractErrorCode.TRANSACTION_TIMEOUT,
        message: `Transaction status could not be confirmed before timing out. It may still succeed — check status manually with hash: ${hash}`,
        fn: FN,
        hash,
      });
    }

    if (getTxResponse.status !== "SUCCESS") {
      throw new ContractError({
        code: ContractErrorCode.TRANSACTION_FAILED,
        message: `Transaction confirmation failed: ${getTxResponse.status}`,
        fn: FN,
        hash,
      });
    }

    return getTxResponse;
  } catch (error) {
    throw parseContractError(error, FN);
  }
}

// ── Horizon reconciliation (#1135) ───────────────────────────────────
//
// Soroban RPC's getTransaction() only retains recent history, so a
// transaction whose confirmation polling timed out isn't necessarily lost —
// it may simply need more time, or may only be checkable via Horizon (which
// retains transaction history far longer) by the time anyone looks again.

export type HorizonTransactionStatus = "SUCCESS" | "FAILED" | "NOT_FOUND";

export interface HorizonTransactionResult {
  hash: string;
  status: HorizonTransactionStatus;
}

/**
 * Look up a transaction's final status directly on Horizon. Used to
 * reconcile a transaction whose Soroban RPC polling timed out.
 */
export async function checkTransactionOnHorizon(
  hash: string,
  horizonBaseUrl: string = HORIZON_URL,
  fetchFn: typeof fetch = fetch,
): Promise<HorizonTransactionResult> {
  const base = horizonBaseUrl.replace(/\/+$/, "");
  const res = await fetchFn(`${base}/transactions/${hash}`);

  if (res.status === 404) {
    return { hash, status: "NOT_FOUND" };
  }
  if (!res.ok) {
    throw new ContractError({
      code: ContractErrorCode.UNKNOWN,
      message: `Horizon transaction lookup failed: ${res.status}`,
      fn: "checkTransactionOnHorizon",
      hash,
    });
  }

  const data = (await res.json()) as { successful?: boolean };
  return { hash, status: data.successful ? "SUCCESS" : "FAILED" };
}

/**
 * Background reconciler for a transaction left in a pending/unknown state
 * after submitSignedTransaction times out (TRANSACTION_TIMEOUT). Polls
 * Horizon at a fixed interval until the transaction resolves to a terminal
 * status or `maxAttempts` is exhausted (in which case it stays NOT_FOUND —
 * callers should treat that as "still unknown," not "failed").
 *
 * Intended to be driven from a hook/effect after a timeout, e.g.:
 *   reconcilePendingTransaction(err.hash).then((r) => setStatus(r.status))
 */
export async function reconcilePendingTransaction(
  hash: string,
  options: {
    horizonBaseUrl?: string;
    intervalMs?: number;
    maxAttempts?: number;
    fetchFn?: typeof fetch;
  } = {},
): Promise<HorizonTransactionResult> {
  const {
    horizonBaseUrl = HORIZON_URL,
    intervalMs = 5_000,
    maxAttempts = 12,
    fetchFn = fetch,
  } = options;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    const result = await checkTransactionOnHorizon(hash, horizonBaseUrl, fetchFn).catch(
      (): HorizonTransactionResult => ({ hash, status: "NOT_FOUND" }),
    );

    if (result.status !== "NOT_FOUND") {
      return result;
    }
  }

  return { hash, status: "NOT_FOUND" };
}
