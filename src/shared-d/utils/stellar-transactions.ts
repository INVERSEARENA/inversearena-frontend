import {
    Account,
    BASE_FEE,
    Contract,
    Operation,
    SorobanDataBuilder,
    TimeoutInfinite,
    TransactionBuilder,
    nativeToScVal,
    xdr,
} from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";

// Constants (Replace with real Contract IDs in production/env)
export const FACTORY_CONTRACT_ID = "CB..."; // TODO: Add real Factory Contract ID
export const XLM_CONTRACT_ID = "CAS3J7GYLGXMF6TDJBXBGMELNUPVCGXIZ68TZE6GTVASJ63Y32KXVY77"; // Testnet Native SAC
export const USDC_CONTRACT_ID = "CC..."; // TODO: Add real USDC Contract ID

export const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"; // Testnet
export const SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

/**
 * Helper to get the latest sequence number for an account
 */
async function getAccount(publicKey: string): Promise<Account> {
    // Using Horizon for sequence number
    const res = await fetch(`https://horizon-testnet.stellar.org/accounts/${publicKey}`);
    if (!res.ok) {
        // If account not found on Horizon, it might be unfunded. 
        // For this flow, we assume funded account.
        throw new Error("Account not found on network. Please fund it.");
    }
    const data = await res.json();
    return new Account(publicKey, data.sequence);
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
    }
) {
    const account = await getAccount(publicKey);
    const factory = new Contract(FACTORY_CONTRACT_ID);

    // Convert stake amount (float) to stroops/units (integer)
    // Assuming 7 decimals for XLM/USDC on Stellar usually 7.
    const amountBigInt = BigInt(Math.floor(params.stakeAmount * 10_000_000));

    const args = [
        nativeToScVal(amountBigInt, { type: "i128" }),
        new Contract(params.currency === "USDC" ? USDC_CONTRACT_ID : XLM_CONTRACT_ID).address().toScVal(),
        nativeToScVal(params.roundSpeed === "30S" ? 30 : params.roundSpeed === "1M" ? 60 : 300, { type: "u32" }),
        nativeToScVal(params.arenaCapacity, { type: "u32" }),
    ];

    const callOperation = factory.call("create_pool", ...args);

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(callOperation)
        .setTimeout(TimeoutInfinite)
        .build();

    return tx;
}

/**
 * Build transaction to Join an Arena
 */
export async function buildJoinArenaTransaction(
    publicKey: string,
    poolId: string, // Contract Address of the pool
    amount: number
) {
    const account = await getAccount(publicKey);
    const poolContract = new Contract(poolId);

    // Invoke 'join'
    const callOperation = poolContract.call("join");

    const tx = new TransactionBuilder(account, {
        fee: "10000",
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(callOperation)
        .setTimeout(30)
        .build();

    return tx;
}

/**
 * Submit choice (Heads/Tails)
 */
export async function buildSubmitChoiceTransaction(
    publicKey: string,
    poolId: string,
    choice: "Heads" | "Tails",
    roundNumber: number
) {
    const account = await getAccount(publicKey);
    const poolContract = new Contract(poolId);

    // Enum or Symbol for choice
    const choiceVal = xdr.ScVal.scvSymbol(choice === "Heads" ? "Heads" : "Tails");

    const callOperation = poolContract.call("submit_choice",
        nativeToScVal(roundNumber, { type: "u32" }),
        choiceVal
    );

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(callOperation)
        .setTimeout(30)
        .build();

    return tx;
}

/**
 * Claim Winnings
 */
export async function buildClaimWinningsTransaction(
    publicKey: string,
    poolId: string
) {
    const account = await getAccount(publicKey);
    const poolContract = new Contract(poolId);

    const callOperation = poolContract.call("claim");

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(callOperation)
        .setTimeout(30)
        .build();

    return tx;
}

/**
 * Submit a signed transaction to the network
 */
export async function submitSignedTransaction(signedXdr: string) {
    const server = new Server(SOROBAN_RPC_URL);

    // Parse the transaction
    const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);

    const response = await server.sendTransaction(tx);

    if (response.status !== "PENDING") {
        // Check for errorResultXdr to get more details
        throw new Error(`Transaction failed: ${response.status}`);
    }

    // Poll for final status
    const hash = response.hash;
    let getTxResponse;

    const MAX_RETRIES = 10;
    let retries = 0;

    while (retries < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 2000));
        try {
            getTxResponse = await server.getTransaction(hash);
            if (getTxResponse.status !== "NOT_FOUND") {
                break;
            }
        } catch (e) {
            // Ignore if fetch fails during polling
        }
        retries++;
    }

    if (!getTxResponse || getTxResponse.status !== "SUCCESS") {
        throw new Error(`Transaction validation failed: ${getTxResponse?.status}`);
    }

    return getTxResponse;
}
