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
  buildGetArenaStateCallOperation,
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
  parseArenaStateFromScVal,
  parseUserStateFromScVal,
  buildArenaDisplayState,
} from "@/shared-d/utils/contract-state-parsers";
import { stroopsToDisplayAmount } from "@/shared-d/utils/stellar-scval-extract";
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
) {
  const FN = "buildJoinArenaTransaction";
  try {
    const validatedPublicKey = StellarPublicKeySchema.parse(publicKey);
    const validatedPoolId = StellarContractIdSchema.parse(poolId);

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
    saveCommitment(validatedPoolId, validatedRoundNumber, validatedPublicKey, {
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

    const stored = loadCommitment(validatedPoolId, validatedRoundNumber, validatedPublicKey);
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
export function clearCommitmentForRound(poolId: string, roundNumber: number, publicKey: string): void {
  clearCommitment(poolId, roundNumber, publicKey);
}

/** True if this device has a stored commitment for the round — i.e. reveal is possible (#1137). */
export function hasStoredCommitmentForRound(poolId: string, roundNumber: number, publicKey: string): boolean {
  return loadCommitment(poolId, roundNumber, publicKey) !== null;
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
  gameState: number | null;
  entryFee: number | null;
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

    // Public arena state requires no wallet address — always succeeds.
    // User-specific fields (isUserIn, hasWon, currentStake, potentialPayout)
    // are only available when a valid user address is provided.
    const getStateOperation = validatedUserAddress
      ? buildGetFullStateCallOperation(arenaContract, validatedUserAddress)
      : buildGetArenaStateCallOperation(arenaContract);

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

    const arenaState = parseArenaStateFromScVal(stateData);
    const userState = validatedUserAddress ? parseUserStateFromScVal(stateData) : { active: false, won: false };
    const display = buildArenaDisplayState(arenaState);

    // entry_fee, player_count, and game_state aren't part of get_full_state's
    // return value yet (contract follow-up). Returning null instead of
    // hardcoded "real" values forces callers to handle the unknown state (#1330).
    return {
      arenaId: validatedArenaId,
      survivorsCount: display.survivorsCount,
      maxCapacity: display.maxCapacity,
      isUserIn: userState.active,
      hasWon: userState.won,
      currentStake: display.currentStake,
      potentialPayout: display.potentialPayout,
      roundNumber: display.roundNumber,
      gameState: null,
      entryFee: null,
      playerCount: display.survivorsCount,
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

// ── Deterministic client reconciliation (#1385) ──────────────────────
//
// After a Soroban transaction's confirmation, the client boundary must
// converge its optimistic state to chain state in a deterministic way,
// regardless of whether the transaction succeeded, was rejected, or timed
// out with an unknown status. This section is that single enforced
// implementation:
//
//   - `captureTransactionOutcome` maps any error thrown by
//     `submitSignedTransaction` (or equivalent) to a typed `TransactionOutcome`.
//   - `reconcileTransaction` resolves an outcome to a terminal
//     `ReconcileStatus` (`CONFIRMED` | `REJECTED` | `UNKNOWN`), deduping
//     duplicate deliveries, sharing concurrent work for the same hash,
//     retrying unknown transactions via Horizon (#1135), and emitting
//     structured observability events (success / failure / retry / timeout)
//     with latency so operators and developers can diagnose the boundary.
//
// State transitions (deterministic):
//   SUCCESS  -> CONFIRMED immediately (source: rpc, 0 retries)
//   REJECTED -> REJECTED immediately (terminal failure is authoritative)
//   TIMEOUT  -> poll Horizon; SUCCESS -> CONFIRMED, FAILED -> REJECTED,
//               exhausted -> UNKNOWN (still "unknown", never a hard failure)
//
// Compatibility constraints:
//   - Public behavior of `submitSignedTransaction`, `checkTransactionOnHorizon`,
//     and `reconcilePendingTransaction` is preserved unchanged.
//   - The reconciliation cache is in-memory; a page reload loses it, but the
//     normal polling path in `useArenaState` (and a fresh `reconcile()` after
//     restart) reconverges to chain state by reading the chain directly.

export type TransactionOutcome =
  | { status: "SUCCESS"; hash: string }
  | { status: "REJECTED"; hash?: string; reason: ContractErrorCode }
  | { status: "TIMEOUT"; hash: string };

export type ReconcileStatus = "CONFIRMED" | "REJECTED" | "UNKNOWN";

export type ReconciliationSource = "rpc" | "horizon";

export interface ReconciliationResult {
  /** The outcome that triggered this reconciliation. */
  outcome: TransactionOutcome;
  /** Terminal, deterministic resolution of the outcome. */
  resolved: ReconcileStatus;
  /** Transaction hash this reconciliation converged on. */
  hash: string;
  /** Number of Horizon retries performed before resolving. */
  retries: number;
  /** Wall-clock time spent reconciling, in milliseconds. */
  latencyMs: number;
  /** Where the resolution was established. */
  source: ReconciliationSource;
}

export type ReconciliationEventKind =
  | "success"
  | "failure"
  | "retry"
  | "timeout";

export interface ReconciliationEvent {
  event: ReconciliationEventKind;
  hash: string;
  outcome: TransactionOutcome["status"];
  resolved: ReconcileStatus;
  retries: number;
  latencyMs: number;
  source: ReconciliationSource;
  /** Present when the outcome was REJECTED. */
  reason?: ContractErrorCode;
  /** Present when the caller supplied an arenaId for correlation. */
  arenaId?: string;
  /** True when this event corresponds to a deduped duplicate delivery. */
  deduped?: boolean;
}

export type ReconciliationEventSink = (event: ReconciliationEvent) => void;

export interface ReconciliationOptions {
  /** Override Horizon base URL. Defaults to the configured HORIZON_URL. */
  horizonBaseUrl?: string;
  /** Poll interval between Horizon attempts. Defaults to 5s. */
  intervalMs?: number;
  /** Max Horizon attempts before resolving UNKNOWN. Defaults to 12. */
  maxAttempts?: number;
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
  /** Structured-log sink for observability events. Defaults to console.info. */
  eventSink?: ReconciliationEventSink;
  /** Optional correlation context (e.g. the arenaId driving the transaction). */
  arenaId?: string;
}

const defaultReconciliationEventSink: ReconciliationEventSink = (event) => {
  console.info(`[client-reconciliation] ${JSON.stringify(event)}`);
};

function isTerminalResolution(resolved: ReconcileStatus): boolean {
  return resolved === "CONFIRMED" || resolved === "REJECTED";
}

function isValidTransactionHash(hash: string): boolean {
  return typeof hash === "string" && hash.length >= 8 && hash.length <= 128;
}

/** Cache of terminal resolutions keyed by hash — powers duplicate-delivery idempotency. */
const reconciliationCache = new Map<string, ReconciliationResult>();
/** In-flight reconciliations keyed by hash — dedupes concurrent requests. */
const inFlightReconciliations = new Map<string, Promise<ReconciliationResult>>();

/**
 * Map an error thrown while submitting/confirming a transaction to a typed
 * {@link TransactionOutcome}. TRANSACTION_TIMEOUT (carrying a hash) becomes
 * TIMEOUT — the only status that means "may still succeed" and therefore the
 * only one that needs Horizon reconciliation. Everything else is a REJECTED
 * terminal outcome.
 */
export function captureTransactionOutcome(error: unknown): TransactionOutcome {
  const parsed =
    error instanceof ContractError
      ? error
      : parseContractError(error, "captureTransactionOutcome");

  if (parsed.code === ContractErrorCode.TRANSACTION_TIMEOUT && parsed.hash) {
    return { status: "TIMEOUT", hash: parsed.hash };
  }

  return {
    status: "REJECTED",
    ...(parsed.hash ? { hash: parsed.hash } : {}),
    reason: parsed.code,
  };
}

function emitFinal(
  sink: ReconciliationEventSink,
  result: ReconciliationResult,
  extra: { deduped?: boolean; arenaId?: string },
): void {
  const event: ReconciliationEvent =
    result.resolved === "CONFIRMED"
      ? {
          event: "success",
          hash: result.hash,
          outcome: result.outcome.status,
          resolved: result.resolved,
          retries: result.retries,
          latencyMs: result.latencyMs,
          source: result.source,
        }
      : result.resolved === "REJECTED"
        ? {
            event: "failure",
            hash: result.hash,
            outcome: result.outcome.status,
            resolved: result.resolved,
            retries: result.retries,
            latencyMs: result.latencyMs,
            source: result.source,
            ...(result.outcome.status === "REJECTED"
              ? { reason: result.outcome.reason }
              : {}),
          }
        : {
            event: "timeout",
            hash: result.hash,
            outcome: result.outcome.status,
            resolved: result.resolved,
            retries: result.retries,
            latencyMs: result.latencyMs,
            source: result.source,
          };

  sink({
    ...event,
    ...(extra.deduped ? { deduped: true } : {}),
    ...(extra.arenaId ? { arenaId: extra.arenaId } : {}),
  });
}

/** Optional correlation context, honoring exactOptionalPropertyTypes. */
function clusterArenaId(options: ReconciliationOptions): { arenaId?: string } {
  return options.arenaId ? { arenaId: options.arenaId } : {};
}

async function resolveReconciliation(
  outcome: TransactionOutcome,
  options: ReconciliationOptions,
  sink: ReconciliationEventSink,
): Promise<ReconciliationResult> {
  const startedAt = Date.now();
  // reconcileTransaction guarantees a valid hash before delegating here.
  const hash = outcome.hash;
  if (!hash || !isValidTransactionHash(hash)) {
    throw new ContractError({
      code: ContractErrorCode.VALIDATION_FAILED,
      message: `Cannot reconcile transaction: missing or invalid transaction hash "${hash}".`,
      fn: "resolveReconciliation",
    });
  }

  if (outcome.status === "SUCCESS") {
    const result: ReconciliationResult = {
      outcome,
      resolved: "CONFIRMED",
      hash,
      retries: 0,
      latencyMs: 0,
      source: "rpc",
    };
    emitFinal(sink, result, clusterArenaId(options));
    return result;
  }

  if (outcome.status === "REJECTED") {
    const result: ReconciliationResult = {
      outcome,
      resolved: "REJECTED",
      hash,
      retries: 0,
      latencyMs: Date.now() - startedAt,
      source: "rpc",
    };
    emitFinal(sink, result, clusterArenaId(options));
    return result;
  }

  // TIMEOUT: the final status is unknown. Converge via Horizon, which retains
  // transaction history far longer than Soroban RPC's getTransaction window.
  let retries = 0;
  const baseFetchFn = options.fetchFn ?? fetch;
  const trackedFetchFn: typeof fetch = (input, init) =>
    baseFetchFn(input, init).then((response) => {
      if (response.status === 404) {
        retries += 1;
        sink({
          event: "retry",
          hash,
          outcome: outcome.status,
          resolved: "UNKNOWN",
          retries,
          latencyMs: Date.now() - startedAt,
          source: "horizon",
        });
      }
      return response;
    });

  const horizonResult = await reconcilePendingTransaction(hash, {
    ...(options.horizonBaseUrl ? { horizonBaseUrl: options.horizonBaseUrl } : {}),
    ...(options.intervalMs ? { intervalMs: options.intervalMs } : {}),
    ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
    fetchFn: trackedFetchFn,
  });

  const resolved: ReconcileStatus =
    horizonResult.status === "SUCCESS"
      ? "CONFIRMED"
      : horizonResult.status === "FAILED"
        ? "REJECTED"
        : "UNKNOWN";

  const result: ReconciliationResult = {
    outcome,
    resolved,
    hash,
    retries,
    latencyMs: Date.now() - startedAt,
    source: "horizon",
  };
  emitFinal(sink, result, clusterArenaId(options));
  return result;
}

/**
 * Deterministic client reconciliation of a transaction outcome (#1385).
 *
 * Converges an optimistic/unknown client state to the chain's authoritative
 * state after a Soroban transaction's confirmation attempt. Idempotent for
 * duplicate deliveries and concurrent requests sharing the same hash: once a
 * hash has resolved to a terminal status, later calls return the cached result
 * (or share the in-flight promise) instead of re-querying the network.
 *
 * Callers should converge their UI to {@link ReconciliationResult.resolved}
 * (e.g. via `useArenaState().reconcile(publicKey)`) whenever the result is
 * CONFIRMED or REJECTED; UNKNOWN means "still unknown, keep the last known
 * state and rely on the normal polling path to converge later".
 */
export async function reconcileTransaction(
  outcome: TransactionOutcome,
  options: ReconciliationOptions = {},
): Promise<ReconciliationResult> {
  const sink: ReconciliationEventSink =
    options.eventSink ?? defaultReconciliationEventSink;

  // A REJECTED outcome without a hash is terminal on its own — there is
  // nothing to look up, so it resolves deterministically.
  if (outcome.status === "REJECTED" && !outcome.hash) {
    const startedAt = Date.now();
    const result: ReconciliationResult = {
      outcome,
      resolved: "REJECTED",
      hash: "",
      retries: 0,
      latencyMs: Date.now() - startedAt,
      source: "rpc",
    };
    emitFinal(sink, result, clusterArenaId(options));
    return result;
  }

  const hash = outcome.hash;
  if (!hash || !isValidTransactionHash(hash)) {
    throw new ContractError({
      code: ContractErrorCode.VALIDATION_FAILED,
      message: `Cannot reconcile transaction: missing or invalid transaction hash "${hash}".`,
      fn: "reconcileTransaction",
    });
  }

  // Duplicate delivery: a terminal resolution is authoritative. A duplicate
  // TIMEOUT for an already-UNKNOWN hash carries no new information either.
  const cached = reconciliationCache.get(hash);
  if (cached) {
    if (isTerminalResolution(cached.resolved) || outcome.status === "TIMEOUT") {
      emitFinal(sink, cached, { deduped: true, ...clusterArenaId(options) });
      return cached;
    }
  }

  // Concurrent requests for the same hash share one deterministic outcome.
  const inFlight = inFlightReconciliations.get(hash);
  if (inFlight) {
    return inFlight;
  }

  const run = (async () => {
    try {
      const result = await resolveReconciliation(outcome, options, sink);
      reconciliationCache.set(hash, result);
      return result;
    } finally {
      inFlightReconciliations.delete(hash);
    }
  })();

  inFlightReconciliations.set(hash, run);
  return run;
}
