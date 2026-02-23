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
    `https://horizon-testnet.stellar.org/accounts/${validatedPublicKey}`,
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
 * Fetch the latest arena state from the contract.
 */
export async function fetchArenaState(arenaId: string, userAddress?: string) {
  const validatedArenaId = StellarContractIdSchema.parse(arenaId);
  if (userAddress) {
    StellarPublicKeySchema.parse(userAddress);
  }

  // Mock contract call while ABI/state integration is pending.
  await new Promise((resolve) => setTimeout(resolve, 500));

  return {
    arenaId: validatedArenaId,
    survivorsCount: 128,
    maxCapacity: 1024,
    isUserIn: Boolean(userAddress),
    hasWon: false,
    currentStake: 1200,
    potentialPayout: 24420,
    roundNumber: 12,
  };
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
