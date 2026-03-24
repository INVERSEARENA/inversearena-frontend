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
  STELLAR_NETWORK,
  TRANSACTION_CONFIG,
} from "@/components/hook-d/arenaConstants";
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
  buildGetUserStateCallOperation,
  buildJoinCallOperation,
  buildStakeCallOperation,
  buildSubmitChoiceCallOperation,
  composeUnsignedTransaction,
} from "@/shared-d/utils/soroban-transaction-composer";
import { CreatePoolParamsSchema } from "@/shared-d/utils/stellar-transaction-schemas";
import {
  extractBoolFromScVal,
  extractI128FromScVal,
  extractU32FromScVal,
} from "@/shared-d/utils/stellar-scval-extract";

// Re-export so consumers can import from one place
export { ContractError, ContractErrorCode, parseContractError } from "@/shared-d/utils/contract-error";

export { ContractClientFactory } from "@/shared-d/utils/contract-client-factory";
export type { ContractClientFactoryDeps } from "@/shared-d/utils/contract-client-factory";

// Constants (Replace with real Contract IDs in production/env)
export const FACTORY_CONTRACT_ID = STELLAR_NETWORK.CONTRACTS.FACTORY;
export const XLM_CONTRACT_ID = STELLAR_NETWORK.CONTRACTS.XLM;
export const USDC_CONTRACT_ID = STELLAR_NETWORK.CONTRACTS.USDC;

const STAKING_CONTRACT_PLACEHOLDER =
  STELLAR_NETWORK.CONTRACTS.STAKING_PLACEHOLDER;
export const STAKING_CONTRACT_ID =
  process.env.NEXT_PUBLIC_STAKING_CONTRACT_ID || STAKING_CONTRACT_PLACEHOLDER;

export const NETWORK_PASSPHRASE = STELLAR_NETWORK.PASSPHRASE;
export const HORIZON_URL = STELLAR_NETWORK.HORIZON_URL.replace(/\/+$/, "");
export const SOROBAN_RPC_URL = STELLAR_NETWORK.SOROBAN_RPC_URL;

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
    });

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
      STAKING_CONTRACT_ID === STAKING_CONTRACT_PLACEHOLDER ||
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
    const operation = buildJoinCallOperation(poolContract);

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
 * Submit choice (Heads/Tails).
 */
export async function buildSubmitChoiceTransaction(
  publicKey: string,
  poolId: string,
  choice: "Heads" | "Tails",
  roundNumber: number,
) {
  const FN = "buildSubmitChoiceTransaction";
  try {
    const validatedPublicKey = StellarPublicKeySchema.parse(publicKey);
    const validatedPoolId = StellarContractIdSchema.parse(poolId);
    const validatedChoice = RoundChoiceSchema.parse(choice);
    const validatedRoundNumber = RoundNumberSchema.parse(roundNumber);

    const account = await getAccount(validatedPublicKey, FN);
    const poolContract = defaultSorobanClients.createContract(validatedPoolId);
    const operation = buildSubmitChoiceCallOperation(
      poolContract,
      validatedRoundNumber,
      validatedChoice,
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

    const account = await getAccount(validatedPublicKey, FN);
    const poolContract = defaultSorobanClients.createContract(validatedPoolId);
    const operation = buildClaimCallOperation(poolContract);

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

    const getStateOperation =
      buildGetArenaStateCallOperation(arenaContract);
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
    const currentStake = extractI128FromScVal(stateData, "current_stake") || 0;
    const potentialPayout =
      extractI128FromScVal(stateData, "potential_payout") || 0;

    let isUserIn = false;
    let hasWon = false;

    if (validatedUserAddress) {
      const userStateOperation = buildGetUserStateCallOperation(
        arenaContract,
        validatedUserAddress,
      );

      const userStateTx = composeUnsignedTransaction(dummyAccount, {
        fee: getDefaultInvokeBaseFee(),
        networkPassphrase: NETWORK_PASSPHRASE,
        timeout: getShortTxTimeoutSeconds(),
        operation: userStateOperation,
      });

      const userSimulation = await server.simulateTransaction(userStateTx);

      if (
        !("error" in userSimulation) &&
        "result" in userSimulation &&
        userSimulation.result?.retval
      ) {
        const userData = userSimulation.result.retval;
        isUserIn = extractBoolFromScVal(userData, "is_active") || false;
        hasWon = extractBoolFromScVal(userData, "has_won") || false;
      }
    }

    return {
      arenaId: validatedArenaId,
      survivorsCount,
      maxCapacity,
      isUserIn,
      hasWon,
      currentStake,
      potentialPayout,
      roundNumber,
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

    if (!getTxResponse) {
      throw new ContractError({
        code: ContractErrorCode.TRANSACTION_TIMEOUT,
        fn: FN,
      });
    }

    if (getTxResponse.status !== "SUCCESS") {
      throw new ContractError({
        code: ContractErrorCode.TRANSACTION_FAILED,
        message: `Transaction confirmation failed: ${getTxResponse.status}`,
        fn: FN,
      });
    }

    return getTxResponse;
  } catch (error) {
    throw parseContractError(error, FN);
  }
}
