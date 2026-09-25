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

import { Contract, Keypair, nativeToScVal, scValToNative, xdr, rpc } from "@stellar/stellar-sdk";
import { StellarRpcGateway } from "../../frontend/src/shared-d/services/stellarRpcGateway";
import { getStellarConfig } from "../config/stellarConfig";

let sourcePublicKey: string | null = null;
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


/**
 * Test seam — mirrors the pattern used in arenaService.ts / ledgerClock.ts.
 * When set, simulateViewCall bypasses the real StellarRpcGateway and talks
 * directly to this stub server instead.
 */
let rpcServerOverride: rpc.Server | null = null;

export function setRpcServerForTest(server: rpc.Server | null): void {
  rpcServerOverride = server;
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
  stellarRpcGateway: StellarRpcGateway,
  args: xdr.ScVal[] = [],
): Promise<unknown> {
  const sourceAccount = rpcServerOverride
    ? await rpcServerOverride.getAccount(getSourcePublicKey())
    : await stellarRpcGateway.getAccount(getSourcePublicKey(), `simulateViewCall.${functionName}`);

  const contract = new Contract(contractId);
  const tx = new (await import("@stellar/stellar-sdk")).TransactionBuilder(sourceAccount, {
    fee: "100",
    networkPassphrase: getStellarConfig().networkPassphrase,
  })
    .addOperation(contract.call(functionName, ...args))
    .setTimeout(60)
    .build();

  const result = rpcServerOverride
    ? await rpcServerOverride.simulateTransaction(tx)
    : await stellarRpcGateway.simulateTransaction(tx);

  if ("error" in result) {
    throw new Error(`Simulation error for ${functionName}: ${result.error}`);
  }

  if (!result.result) {
    throw new Error(`Simulation returned no result for ${functionName}`);
  }

  return scValToNative(result.result.retval);
}

/**
 * Read the on-chain game state for an arena contract.
 * Returns the state string ("Open", "InProgress", "Finished", "Cancelled").
 */
export async function getOnChainGameState(contractId: string): Promise<OnChainGameState> {
  const stellarRpcGateway = new StellarRpcGateway();
  try {
    const result = await simulateViewCall(contractId, "game_state", stellarRpcGateway);
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
 * Read a deployed contract's `version()` return value.
 *
 * Unlike getOnChainGameState/getOnChainPlayerCount above, this propagates
 * failures instead of defaulting — contractCapability.ts (#1409) needs to
 * know definitively whether a version read succeeded, since a silently
 * defaulted version would let capability negotiation treat an
 * unreachable/pre-version-endpoint deployment as if it were running a
 * known version.
 */
export async function getOnChainContractVersion(contractId: string): Promise<number> {
  const stellarRpcGateway = new StellarRpcGateway();
  try {
    const result = await simulateViewCall(contractId, "version", stellarRpcGateway);
    return Number(result as bigint | number);
  } catch (error) {
    throw new OnChainReadError("version", contractId, error);
  }
}

/**
 * Read the on-chain player count for an arena contract.
 * Returns the number of players who joined on-chain.
 */
export async function getOnChainPlayerCount(contractId: string): Promise<number> {
  const stellarRpcGateway = new StellarRpcGateway();
  try {
    const result = await simulateViewCall(contractId, "get_player_count", stellarRpcGateway);
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
  const stellarRpcGateway = new StellarRpcGateway();
  try {
    const result = await simulateViewCall(contractId, "get_players", stellarRpcGateway);
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
  const stellarRpcGateway = new StellarRpcGateway();
  try {
    const pageArg = nativeToScVal(page, { type: "u32" });
    // get_players returns Vec<(Address, PlayerState)>; scValToNative gives
    // an array of [address_string, { active, rounds_survived, ... }] tuples.
    const result = await simulateViewCall(contractId, "get_players", stellarRpcGateway, [pageArg]);
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
  const stellarRpcGateway = new StellarRpcGateway();
  let result: unknown;
  try {
    result = await simulateViewCall(contractId, "get_winner", stellarRpcGateway);
  } catch (error) {
    // A failed read is NOT the same as "no winner yet". Returning null here
    // would let the round commit as RESOLVED with zero payouts, and
    // resolveRound's state guard then rejects every retry — stranding the
    // winner's prize permanently. Surface the failure so the caller can
    // abort and retry.
    throw new OnChainReadError("get_winner", contractId, error);
  }
  // A successful simulation that yields no value genuinely means the contract
  // has not called set_winner yet, i.e. the game is still in progress.
  if (result === null || result === undefined) return null;
  return String(result);
}

/** Combined result of a single successful live-on-chain read (#1408). */
export interface OnChainArenaSnapshot {
  playerCount: number;
  gameState: OnChainGameState;
  yieldAccrued: number;
}

export interface BatchedOnChainArenaSnapshot extends OnChainArenaSnapshot { arenaId: string }

/** Reads all arenas against one ledger snapshot, preventing mixed-ledger hydration. */
export async function getOnChainSnapshots(contractIds: readonly string[], vaultContractId: string): Promise<{ ledgerSequence: number; snapshots: BatchedOnChainArenaSnapshot[] }> {
  if (contractIds.length === 0) return { ledgerSequence: 0, snapshots: [] };
  const gateway = new StellarRpcGateway();
  const ledgerSequence = await gateway.getLatestLedger();
  const snapshots = await Promise.all(contractIds.map(async (arenaId) => ({ arenaId, ...(await getOnChainSnapshotOrThrow(arenaId, vaultContractId)) })));
  return { ledgerSequence, snapshots };
}

/**
 * Read player count, game state, and total yield for an arena in one
 * all-or-nothing attempt (#1408).
 *
 * Unlike getOnChainPlayerCount/getOnChainGameState/getOnChainTotalYield
 * above, this throws on ANY failure instead of silently defaulting a single
 * field — arenaStatsService needs to know whether "this batch of on-chain
 * fields is genuinely live" as one fact, not three independently-defaulting
 * ones, so it can decide whether to serve a flagged last-verified snapshot
 * instead of silently mixing live and stale data.
 */
export async function getOnChainSnapshotOrThrow(
  contractId: string,
  vaultContractId: string,
): Promise<OnChainArenaSnapshot> {
  const stellarRpcGateway = new StellarRpcGateway();
  const [playerCountRaw, gameStateRaw, yieldRaw] = await Promise.all([
    simulateViewCall(contractId, "get_player_count", stellarRpcGateway),
    simulateViewCall(contractId, "game_state", stellarRpcGateway),
    simulateViewCall(vaultContractId, "get_total_yield", stellarRpcGateway),
  ]);

  return {
    playerCount: Number(playerCountRaw as bigint | number),
    gameState: String(gameStateRaw) as OnChainGameState,
    yieldAccrued: Number(yieldRaw as bigint | number),
  };
}

/**
 * Read the total yield accrued from the rwa-adapter vault.
 * Returns the total yield amount as a number.
 */
export async function getOnChainTotalYield(contractId: string): Promise<number> {
  const stellarRpcGateway = new StellarRpcGateway();
  try {
    const result = await simulateViewCall(contractId, "get_total_yield", stellarRpcGateway);
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
