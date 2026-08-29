/**
 * Read-only Soroban contract client for the Arena contract.
 *
 * Calls view functions via simulateTransaction — no signing required.
 * Used to fetch on-chain state so the backend reflects authoritative
 * on-chain truth rather than re-implementing contract logic in TypeScript.
 *
 * Key exports consumed by roundService:
 *  - getOnChainActivePlayerIds  — alive players after resolve_round (#1098)
 *  - getOnChainWinner           — single winner address for payouts (#1099)
 */

import { Contract, Keypair, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
// @ts-ignore
import { rpc } from "@stellar/stellar-sdk";
import { getStellarConfig } from "../config/stellarConfig";
const { Server } = rpc;

/** On-chain game states — matches the contract's GameState enum. */
export type OnChainGameState = "Open" | "InProgress" | "Finished" | "Cancelled";

/**
 * Raised when an on-chain read fails for a transient/infrastructure reason
 * (RPC timeout, simulation error, malformed response) as opposed to the
 * contract legitimately reporting "no value yet".
 *
 * Callers MUST NOT convert this into a benign empty/null result: an empty
 * player list means "everyone was eliminated" and a null winner means "game
 * still in progress", both of which are irreversible state transitions.
 */
export class OnChainReadError extends Error {
  constructor(
    readonly functionName: string,
    readonly contractId: string,
    override readonly cause?: unknown,
  ) {
    super(
      `On-chain read failed for ${functionName} on ${contractId}: ` +
        (cause instanceof Error ? cause.message : String(cause)),
    );
    this.name = "OnChainReadError";
  }
}

let rpcServer: rpc.Server | null = null;
let sourcePublicKey: string | null = null;

function getRpcServer(): rpc.Server {
  if (!rpcServer) {
    rpcServer = new Server(getStellarConfig().sorobanRpcUrl, { allowHttp: false });
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
    networkPassphrase: getStellarConfig().networkPassphrase,
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
 * Read the on-chain player list for an arena contract.
 * Returns an array of player wallet addresses.
 */
export async function getOnChainPlayers(contractId: string): Promise<string[]> {
  try {
    const result = await simulateViewCall(contractId, "get_players");
    // The contract returns a Vec<Address>; scValToNative converts it to an array of strings.
    const players = result as string[];
    return players;
  } catch {
    // If the contract call fails, return empty array.
    return [];
  }
}

/**
 * Read the active player IDs from on-chain after a round has been resolved.
 *
 * The arena contract's `get_players` function returns
 * `Vec<(Address, PlayerState)>` where `PlayerState.active` is the
 * authoritative alive/eliminated flag set by `resolve_round`. Reading
 * this list replaces the TypeScript minority-wins re-implementation in
 * `computeEliminations` (issue #1098).
 *
 * @param contractId  Stellar contract ID of the arena (C…)
 * @param page        Pagination page index passed to `get_players` (0-based)
 * @returns           Array of on-chain wallet addresses that are still active
 */
export async function getOnChainActivePlayerIds(
  contractId: string,
  page = 0,
): Promise<string[]> {
  try {
    const pageArg = nativeToScVal(page, { type: "u32" });
    // get_players returns Vec<(Address, PlayerState)>; scValToNative gives
    // an array of [address_string, { active, rounds_survived, ... }] tuples.
    const result = await simulateViewCall(contractId, "get_players", [pageArg]);
    const entries = result as Array<[string, { active: boolean }]>;
    return entries
      .filter(([, state]) => state.active)
      .map(([addr]) => addr);
  } catch (error) {
    // Propagate: callers must not silently swallow this — an empty list
    // would incorrectly mark all players as eliminated.
    throw new OnChainReadError("get_players", contractId, error);
  }
}

/**
 * Read the single on-chain winner address for a finished arena game.
 *
 * The arena contract stores exactly one winner via `set_winner` inside
 * `resolve_round` when `survivors <= 1`. This is the authoritative
 * recipient for the full prize pool (issue #1099).
 *
 * @param contractId  Stellar contract ID of the arena (C…)
 * @returns           The winner's wallet address, or null if not yet set
 */
export async function getOnChainWinner(
  contractId: string,
): Promise<string | null> {
  try {
    const result = await simulateViewCall(contractId, "get_winner");
    if (result === null || result === undefined) return null;
    return String(result);
  } catch {
    return null;
  }
}

/**
 * Read the total yield accrued from the rwa-adapter vault.
 * Returns the total yield amount as a number.
 */
export async function getOnChainTotalYield(contractId: string): Promise<number> {
  try {
    const result = await simulateViewCall(contractId, "get_total_yield");
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
