import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  TimeoutInfinite,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";
import { z } from "zod";
import {
  ArenaCapacitySchema,
  HorizonAccountResponseSchema,
  PositiveAmountSchema,
  PoolCurrencySchema,
  RoundChoiceSchema,
  RoundNumberSchema,
  RoundSpeedSchema,
  SignedXdrSchema,
  StellarContractIdSchema,
  StellarPublicKeySchema,
} from "@/shared-d/utils/security-validation";
import {
  STELLAR_NETWORK,
  TRANSACTION_CONFIG,
} from "@/components/hook-d/arenaConstants";

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

const CreatePoolParamsSchema = z.object({
  stakeAmount: PositiveAmountSchema,
  currency: PoolCurrencySchema,
  roundSpeed: RoundSpeedSchema,
  arenaCapacity: ArenaCapacitySchema,
});

/**
 * Helper to get the latest sequence number for an account.
 */
async function getAccount(publicKey: string): Promise<Account> {
  const validatedPublicKey = StellarPublicKeySchema.parse(publicKey);

  const res = await fetch(
    `${HORIZON_URL}/accounts/${validatedPublicKey}`,
  );
  if (!res.ok) {
    throw new Error("Account not found on network. Please fund it.");
  }

  const rawData: unknown = await res.json();
  const data = HorizonAccountResponseSchema.parse(rawData);

  return new Account(validatedPublicKey, data.sequence);
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
  const validatedParams = CreatePoolParamsSchema.parse(params);
  const account = await getAccount(publicKey);
  const factory = new Contract(FACTORY_CONTRACT_ID);

  // Convert stake amount to stroops/units (7 decimals).
  const amountBigInt = BigInt(
    Math.floor(validatedParams.stakeAmount * 10_000_000),
  );

  const args = [
    nativeToScVal(amountBigInt, { type: "i128" }),
    new Contract(
      validatedParams.currency === "USDC" ? USDC_CONTRACT_ID : XLM_CONTRACT_ID,
    )
      .address()
      .toScVal(),
    nativeToScVal(
      validatedParams.roundSpeed === "30S"
        ? 30
        : validatedParams.roundSpeed === "1M"
          ? 60
          : 300,
      { type: "u32" },
    ),
    nativeToScVal(validatedParams.arenaCapacity, { type: "u32" }),
  ];

  const callOperation = factory.call("create_pool", ...args);

  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(callOperation)
    .setTimeout(TimeoutInfinite)
    .build();
}

/**
 * Build an unsigned transaction to stake XLM via the protocol contract.
 * Uses Soroban prepareTransaction for correct footprint and fees.
 */
export async function buildStakeProtocolTransaction(
  publicKey: string,
  amount: number,
) {
  const validatedPublicKey = StellarPublicKeySchema.parse(publicKey);
  const validatedAmount = PositiveAmountSchema.parse(amount);

  if (
    !STAKING_CONTRACT_ID ||
    STAKING_CONTRACT_ID === STAKING_CONTRACT_PLACEHOLDER ||
    STAKING_CONTRACT_ID.includes("...")
  ) {
    throw new Error(
      "Staking contract not configured. Add NEXT_PUBLIC_STAKING_CONTRACT_ID to .env.local with your Soroban contract address.",
    );
  }

  const server = new Server(SOROBAN_RPC_URL);
  const account = await getAccount(validatedPublicKey);
  const stakingContract = new Contract(STAKING_CONTRACT_ID);

  const amountStroops = BigInt(Math.floor(validatedAmount * 10_000_000));
  const addressScVal = new Address(validatedPublicKey).toScVal();

  const callOperation = stakingContract.call(
    "stake",
    addressScVal,
    nativeToScVal(amountStroops, { type: "i128" }),
  );

  const builtTx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(callOperation)
    .setTimeout(TimeoutInfinite)
    .build();

  return server.prepareTransaction(builtTx);
}

/**
 * Build transaction to join an arena.
 */
export async function buildJoinArenaTransaction(
  publicKey: string,
  poolId: string,
  amount: number,
) {
  const validatedPublicKey = StellarPublicKeySchema.parse(publicKey);
  const validatedPoolId = StellarContractIdSchema.parse(poolId);
  PositiveAmountSchema.parse(amount);

  const account = await getAccount(validatedPublicKey);
  const poolContract = new Contract(validatedPoolId);
  const callOperation = poolContract.call("join");

  return new TransactionBuilder(account, {
    fee: TRANSACTION_CONFIG.JOIN_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(callOperation)
    .setTimeout(TRANSACTION_CONFIG.TIMEOUT_SECONDS)
    .build();
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
  const validatedPublicKey = StellarPublicKeySchema.parse(publicKey);
  const validatedPoolId = StellarContractIdSchema.parse(poolId);
  const validatedChoice = RoundChoiceSchema.parse(choice);
  const validatedRoundNumber = RoundNumberSchema.parse(roundNumber);

  const account = await getAccount(validatedPublicKey);
  const poolContract = new Contract(validatedPoolId);
  const choiceVal = xdr.ScVal.scvSymbol(
    validatedChoice === "Heads" ? "Heads" : "Tails",
  );

  const callOperation = poolContract.call(
    "submit_choice",
    nativeToScVal(validatedRoundNumber, { type: "u32" }),
    choiceVal,
  );

  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(callOperation)
    .setTimeout(TRANSACTION_CONFIG.TIMEOUT_SECONDS)
    .build();
}

/**
 * Claim winnings.
 */
export async function buildClaimWinningsTransaction(
  publicKey: string,
  poolId: string,
) {
  const validatedPublicKey = StellarPublicKeySchema.parse(publicKey);
  const validatedPoolId = StellarContractIdSchema.parse(poolId);

  const account = await getAccount(validatedPublicKey);
  const poolContract = new Contract(validatedPoolId);
  const callOperation = poolContract.call("claim");

  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(callOperation)
    .setTimeout(30)
    .build();
}

/**
 * Parse Stellar error results to user-friendly messages.
 */
export function parseStellarError(error: unknown): string {
  const errorString =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof error === "object" && error !== null && "message" in error
          ? String((error as { message: unknown }).message)
          : String(error ?? "");

  if (errorString.includes("tx_bad_auth")) {
    return "Invalid or unauthorized transaction. Please check your wallet permissions.";
  }
  if (errorString.includes("op_underfunded")) {
    return "Insufficient balance to cover the transaction and fees.";
  }
  if (errorString.includes("tx_too_late")) {
    return "Transaction expired. Please try again.";
  }
  if (errorString.includes("User rejected")) {
    return "Transaction was cancelled by the user.";
  }

  return errorString || "An unknown error occurred during the transaction.";
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
  userAddress?: string
): Promise<ArenaStateResponse> {
  const validatedArenaId = StellarContractIdSchema.parse(arenaId);
  const validatedUserAddress = userAddress
    ? StellarPublicKeySchema.parse(userAddress)
    : undefined;

  try {
    const server = new Server(SOROBAN_RPC_URL);
    const arenaContract = new Contract(validatedArenaId);

    // Build a dummy account for simulation (no actual signing needed for reads)
    const dummyAccount = new Account(
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      "0"
    );

    // Query arena state - adjust method names based on your contract
    const getStateOperation = arenaContract.call("get_arena_state");

    const stateTx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(getStateOperation)
      .setTimeout(30)
      .build();

    // Simulate to read state without submitting
    const stateSimulation = await server.simulateTransaction(stateTx);

    // Type guard: check if simulation was successful
    if (
      "error" in stateSimulation ||
      !("result" in stateSimulation) ||
      !stateSimulation.result ||
      stateSimulation.result.retval === undefined
    ) {
      const errorMsg =
        "error" in stateSimulation ? stateSimulation.error : "Unknown error";
      throw new Error(`Failed to fetch arena state: ${errorMsg}`);
    }

    // Parse the contract response
    // Adjust parsing based on your contract's return structure
    const stateData = stateSimulation.result.retval;
    
    // Extract values from the contract response
    // This assumes the contract returns a struct/map with these fields
    const survivorsCount = extractU32FromScVal(stateData, "survivors_count") || 0;
    const maxCapacity = extractU32FromScVal(stateData, "max_capacity") || 0;
    const roundNumber = extractU32FromScVal(stateData, "round_number") || 0;
    const currentStake = extractI128FromScVal(stateData, "current_stake") || 0;
    const potentialPayout = extractI128FromScVal(stateData, "potential_payout") || 0;

    let isUserIn = false;
    let hasWon = false;

    // If user address provided, check user-specific state
    if (validatedUserAddress) {
      const userStateOperation = arenaContract.call(
        "get_user_state",
        new Address(validatedUserAddress).toScVal()
      );

      const userStateTx = new TransactionBuilder(dummyAccount, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(userStateOperation)
        .setTimeout(30)
        .build();

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
    // Provide structured error handling
    const errorMessage = parseStellarError(error);
    throw new Error(`Arena state fetch failed: ${errorMessage}`);
  }
}

/**
 * Helper to extract u32 value from ScVal
 */
function extractU32FromScVal(scVal: xdr.ScVal, fieldName?: string): number | null {
  try {
    if (fieldName && scVal.switch().name === "scvMap") {
      const map = scVal.map();
      if (!map) return null;
      
      for (const entry of map) {
        const key = entry.key();
        if (key.switch().name === "scvSymbol" && key.sym().toString() === fieldName) {
          const val = entry.val();
          if (val.switch().name === "scvU32") {
            return val.u32();
          }
        }
      }
      return null;
    }
    
    if (scVal.switch().name === "scvU32") {
      return scVal.u32();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Helper to extract i128 value from ScVal
 */
function extractI128FromScVal(scVal: xdr.ScVal, fieldName?: string): number | null {
  try {
    if (fieldName && scVal.switch().name === "scvMap") {
      const map = scVal.map();
      if (!map) return null;
      
      for (const entry of map) {
        const key = entry.key();
        if (key.switch().name === "scvSymbol" && key.sym().toString() === fieldName) {
          const val = entry.val();
          if (val.switch().name === "scvI128") {
            const i128Parts = val.i128();
            // Convert i128 to number (may lose precision for very large values)
            const hi = i128Parts.hi().toBigInt();
            const lo = i128Parts.lo().toBigInt();
            const value = (hi << 64n) | lo;
            return Number(value) / 10_000_000; // Convert from stroops
          }
        }
      }
      return null;
    }
    
    if (scVal.switch().name === "scvI128") {
      const i128Parts = scVal.i128();
      const hi = i128Parts.hi().toBigInt();
      const lo = i128Parts.lo().toBigInt();
      const value = (hi << 64n) | lo;
      return Number(value) / 10_000_000;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Helper to extract boolean value from ScVal
 */
function extractBoolFromScVal(scVal: xdr.ScVal, fieldName?: string): boolean | null {
  try {
    if (fieldName && scVal.switch().name === "scvMap") {
      const map = scVal.map();
      if (!map) return null;
      
      for (const entry of map) {
        const key = entry.key();
        if (key.switch().name === "scvSymbol" && key.sym().toString() === fieldName) {
          const val = entry.val();
          if (val.switch().name === "scvBool") {
            return val.b();
          }
        }
      }
      return null;
    }
    
    if (scVal.switch().name === "scvBool") {
      return scVal.b();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Submit a signed transaction to the network.
 */
export async function submitSignedTransaction(signedXdr: string) {
  const validatedSignedXdr = SignedXdrSchema.parse(signedXdr);
  const server = new Server(SOROBAN_RPC_URL);

  const tx = TransactionBuilder.fromXDR(validatedSignedXdr, NETWORK_PASSPHRASE);
  const response = await server.sendTransaction(tx);

  if (response.status !== "PENDING") {
    throw new Error(`Transaction failed: ${response.status}`);
  }

  const hash = response.hash;
  let getTxResponse: Awaited<ReturnType<Server["getTransaction"]>> | undefined;

  const MAX_RETRIES = TRANSACTION_CONFIG.MAX_RETRIES;
  let retries = 0;

  while (retries < MAX_RETRIES) {
    await new Promise((resolve) =>
      setTimeout(resolve, TRANSACTION_CONFIG.RETRY_INTERVAL_MS),
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

  if (!getTxResponse || getTxResponse.status !== "SUCCESS") {
    throw new Error(`Transaction validation failed: ${getTxResponse?.status}`);
  }

  return getTxResponse;
}
