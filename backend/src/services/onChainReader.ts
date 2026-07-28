/**
 * Read-only Soroban contract client for the Arena contract.
 *
 * Calls view functions via simulateTransaction — no signing required.
 * Used to fetch on-chain game_state() and get_player_count() so the
 * backend status and player count reflect the truth on-chain rather
 * than stale DB rows.
 */

import { Contract, Keypair, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
// @ts-ignore
import { rpc } from "@stellar/stellar-sdk";
const { Server } = rpc;

/** On-chain game states — matches the contract's GameState enum. */
export type OnChainGameState = "Open" | "InProgress" | "Finished" | "Cancelled";

let rpcServer: rpc.Server | null = null;
let sourcePublicKey: string | null = null;

function getRpcServer(): rpc.Server {
  if (!rpcServer) {
    const url = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
    rpcServer = new Server(url, { allowHttp: false });
  }
  return rpcServer;
}

/**
 * A dummy public key used as the simulation source for read-only calls.
 * Does not need funds — Soroban simulates without submitting.
 */
function getSourcePublicKey(): string {
  if (!sourcePublicKey) {
    // Derive a deterministic public key from an env var or generate a random one.
    // The key itself is irrelevant for simulation — it just needs to be valid.
    const secret = process.env.ARENA_SIM_SOURCE_SECRET;
    if (secret) {
      sourcePublicKey = Keypair.fromSecret(secret).publicKey();
    } else {
      sourcePublicKey = Keypair.random().publicKey();
    }
  }
  return sourcePublicKey;
}

/**
 * Simulate a read-only Soroban contract call.
 * Returns the deserialized return value, or throws on error.
 */
async function simulateViewCall(
  contractId: string,
  functionName: string,
  args: xdr.ScVal[] = [],
): Promise<unknown> {
  const server = getRpcServer();
  const sourceAccount = await server.getAccount(getSourcePublicKey());

  const contract = new Contract(contractId);
  const tx = new (await import("@stellar/stellar-sdk")).TransactionBuilder(sourceAccount, {
    fee: "100",
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
  })
    .addOperation(contract.call(functionName, ...args))
    .setTimeout(60)
    .build();

  const result = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(result)) {
    throw new Error(`Simulation error for ${functionName}: ${result.error}`);
  }

  if (!rpc.Api.isSimulationSuccess(result) || !result.result) {
    throw new Error(`Simulation returned no result for ${functionName}`);
  }

  return scValToNative(result.result.retval);
}

/**
 * Read the on-chain game state for an arena contract.
 * Returns the state string ("Open", "InProgress", "Finished", "Cancelled").
 */
export async function getOnChainGameState(contractId: string): Promise<OnChainGameState> {
  try {
    const result = await simulateViewCall(contractId, "game_state");
    // The contract returns a Symbol; scValToNative converts it to a string.
    const state = String(result) as OnChainGameState;
    return state;
  } catch {
    // If the contract call fails (e.g. not deployed yet), return "Open"
    // as a safe default that won't incorrectly mark arenas as finished.
    return "Open";
  }
}

/**
 * Read the on-chain player count for an arena contract.
 * Returns the number of players who joined on-chain.
 */
export async function getOnChainPlayerCount(contractId: string): Promise<number> {
  try {
    const result = await simulateViewCall(contractId, "get_player_count");
    return Number(result as bigint | number);
  } catch {
    // If the contract call fails, fall back to 0.
    return 0;
  }
}

/**
 * Map an on-chain GameState to the backend status string.
 *
 * The backend ArenaStats status field uses lowercase strings:
 * - "open"     → game is accepting players
 * - "active"   → game in progress (rounds running)
 * - "finished" → game over, winner determined, awaiting claim
 * - "settled"  → prize claimed, game fully resolved
 * - "cancelled" → game was cancelled
 *
 * The on-chain contract does not have a "Settled" state — once a game
 * is "Finished", the prize claim is tracked via the `is_prize_claimed`
 * storage flag. We map that to "settled" so the backend/frontend can
 * distinguish "finished but unclaimed" from "fully settled".
 */
export function mapGameStateToStatus(
  gameState: OnChainGameState,
  prizeClaimed: boolean,
): string {
  switch (gameState) {
    case "Open":
      return "open";
    case "InProgress":
      return "active";
    case "Finished":
      return prizeClaimed ? "settled" : "finished";
    case "Cancelled":
      return "cancelled";
    default:
      return "active";
  }
}
