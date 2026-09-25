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
 *
 * Key exports consumed by the projection replay engine (#1382):
 *  - getArenaEvents             — paginated raw contract event fetch
 *  - toArenaProjectionEvent     — typed boundary: raw RPC event → ArenaProjectionEvent
 */

import { Contract, Keypair, nativeToScVal, scValToNative, xdr, rpc } from "@stellar/stellar-sdk";
import { StellarRpcGateway } from "../../frontend/src/shared-d/services/stellarRpcGateway";
import { getStellarConfig } from "../config/stellarConfig";
import {
  ARENA_EVENT_TOPICS,
  isArenaEventTopic,
  type ArenaProjectionEvent,
} from "./projection/arenaEventTypes";

let sourcePublicKey: string | null = null;
/** On-chain game states — matches the contract's GameState enum. */
export type OnChainGameState = "Open" | "InProgress" | "Finished" | "Cancelled";

/**
 * Test-only override for the raw Soroban RPC server `simulateViewCall` (and
 * everything built on it, e.g. `getFactoryArenaPage`, `getArenaEvents`)
 * uses, bypassing the real `StellarRpcGateway` a caller constructs —
 * mirrors the same `setRpcServerForTest` pattern used in
 * `arenaService.ts`/`ledgerClock.ts`. Restored to `null` (the default: use
 * the real gateway) by passing `null` to `setRpcServerForTest`.
 */
let rpcServerOverride: rpc.Server | null = null;

export function setRpcServerForTest(server: rpc.Server | null): void {
  rpcServerOverride = server;
}

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
  // Test seam: when `setRpcServerForTest` has set an override, it fully
  // replaces the real `stellarRpcGateway` passed in by the caller for the
  // duration of the override — mirrors `arenaService.ts`/`ledgerClock.ts`'s
  // own `setRpcServerForTest` seams. The override is a raw `rpc.Server`
  // (single-arg `getAccount(publicKey)`, matching the SDK's own signature),
  // not the `StellarRpcGateway` wrapper (two-arg `getAccount(publicKey, fn)`,
  // Horizon-backed) — the two call shapes differ, so this branches on which
  // client is active rather than trying to unify them behind one type.
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

/** On-chain lifecycle status of a factory-tracked pool — matches the factory
 * contract's `ArenaStatus` enum (`contract/factory/src/types.rs`). */
export type FactoryArenaStatus = "Pending" | "Active" | "Finished" | "Cancelled";

/**
 * A single pool entry as returned by the factory contract's `get_arenas`
 * view call — matches `ArenaMetadata` (`contract/factory/src/types.rs`).
 */
export interface FactoryArenaMetadata {
  arenaAddress: string;
  poolId: number;
  host: string;
  entryFee: bigint;
  status: FactoryArenaStatus;
  createdAt: number;
}

/**
 * Raised when a page of factory arena metadata cannot be read (RPC failure)
 * or contains a record that fails basic shape validation (malformed/invalid
 * on-chain data). Callers (the backfill worker) must not treat this as "no
 * arenas in this page" — that would silently stop the backfill's cursor from
 * advancing past a page that actually had data.
 */
export class FactoryReadError extends Error {
  constructor(
    readonly reason: string,
    override readonly cause?: unknown,
  ) {
    super(
      `Factory arena read failed: ${reason}` +
        (cause instanceof Error ? ` (${cause.message})` : ""),
    );
    this.name = "FactoryReadError";
  }
}

const CONTRACT_ID_REGEX = /^C[A-Z2-7]{55}$/;

function decodeArenaMetadata(raw: unknown): FactoryArenaMetadata {
  if (!raw || typeof raw !== "object") {
    throw new FactoryReadError("arena metadata entry is not an object");
  }
  const entry = raw as Record<string, unknown>;

  const arenaAddress = entry.arena_address;
  if (typeof arenaAddress !== "string" || !CONTRACT_ID_REGEX.test(arenaAddress)) {
    throw new FactoryReadError(
      `arena_address is not a valid Soroban contract id: ${String(arenaAddress)}`,
    );
  }

  const poolIdRaw = entry.pool_id;
  const poolId = Number(poolIdRaw as bigint | number);
  if (!Number.isInteger(poolId) || poolId <= 0) {
    throw new FactoryReadError(`pool_id is not a positive integer: ${String(poolIdRaw)}`);
  }

  const host = entry.host;
  if (typeof host !== "string" || host.length === 0) {
    throw new FactoryReadError("host is missing or not a string");
  }

  const entryFeeRaw = entry.entry_fee;
  let entryFee: bigint;
  try {
    entryFee = BigInt(entryFeeRaw as bigint | number | string);
  } catch {
    throw new FactoryReadError(`entry_fee is not a valid integer: ${String(entryFeeRaw)}`);
  }

  // `ArenaStatus` (contract/factory/src/types.rs) is a fieldless Rust enum.
  // soroban-sdk's #[contracttype] derive encodes a fieldless enum variant as
  // a one-element ScVec containing the variant's Symbol (`Vec([Symbol("Active")])`),
  // not a bare Symbol — scValToNative therefore decodes it to a one-element
  // array (`["Active"]`), not the string `"Active"`. Comparing `entry.status`
  // directly against a string would never match any real on-chain value and
  // would permanently fail every record. Confirmed empirically against the
  // actual contract encoding (soroban-sdk 22.x) before writing this check.
  const statusRaw = Array.isArray(entry.status) ? entry.status[0] : entry.status;
  const validStatuses: FactoryArenaStatus[] = ["Pending", "Active", "Finished", "Cancelled"];
  const status = validStatuses.find((candidate) => candidate === statusRaw);
  if (!status) {
    throw new FactoryReadError(`status is not a recognized ArenaStatus: ${String(statusRaw)}`);
  }

  const createdAtRaw = entry.created_at;
  const createdAt = Number(createdAtRaw as bigint | number);
  if (!Number.isFinite(createdAt) || createdAt < 0) {
    throw new FactoryReadError(`created_at is not a valid timestamp: ${String(createdAtRaw)}`);
  }

  return { arenaAddress, poolId, host, entryFee, status, createdAt };
}

/**
 * Read one page of factory-tracked arenas via the factory contract's
 * `get_arenas(offset, limit)` view call (#1391).
 *
 * `offset` is the number of pools to skip (0-indexed); `limit` is clamped to
 * 50 server-side by the contract regardless of what is requested here.
 * Results are ordered by ascending `pool_id`, so the caller can treat
 * `offset + results.length` as the next page's offset and detect the end of
 * the list by getting back fewer than `limit` results (or zero).
 *
 * Throws `FactoryReadError` on any RPC failure or malformed record — this is
 * a deliberate contrast with the other `getOnChain*` helpers in this module,
 * which return safe fallback values on failure. A backfill job silently
 * treating "RPC failed" the same as "no arenas here" would advance its
 * cursor past pools it never actually read, permanently losing them.
 */
export async function getFactoryArenaPage(
  factoryContractId: string,
  offset: number,
  limit: number,
): Promise<FactoryArenaMetadata[]> {
  let result: unknown;
  try {
    const stellarRpcGateway = new StellarRpcGateway();
    const offsetArg = nativeToScVal(offset, { type: "u32" });
    const limitArg = nativeToScVal(limit, { type: "u32" });
    result = await simulateViewCall(factoryContractId, "get_arenas", stellarRpcGateway, [offsetArg, limitArg]);
  } catch (error) {
    throw new FactoryReadError(
      `get_arenas(${offset}, ${limit}) simulation failed on ${factoryContractId}`,
      error,
    );
  }

  if (!Array.isArray(result)) {
    throw new FactoryReadError(
      `get_arenas(${offset}, ${limit}) returned a non-array result`,
    );
  }

  return result.map((entry) => decodeArenaMetadata(entry));
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

// ---------------------------------------------------------------------------
// Event log reading (#1382) — the typed boundary between raw Soroban RPC
// event payloads and the projection fold. Nothing outside this module and
// `services/projection/*` should touch `xdr.ScVal` or the raw RPC event
// shape directly; everything downstream consumes `ArenaProjectionEvent`.
// ---------------------------------------------------------------------------

/** One page of raw contract events as returned by Soroban RPC `getEvents`. */
export interface ArenaEventPage {
  events: ArenaProjectionEvent[];
  /** RPC's own view of the chain tip at the time of this call. */
  latestLedger: number;
  /**
   * Opaque pagination token for the next page, or null if this page reached
   * `latestLedger` (i.e. there is nothing further to fetch right now).
   */
  cursor: string | null;
}

/**
 * Decode a single raw Soroban RPC contract event into a typed
 * `ArenaProjectionEvent`. Never throws: an event whose topic is unrecognized,
 * or whose payload fails to decode, becomes an `ArenaUnknownEvent` so the
 * projection fold can record it as a skip rather than replay grinding to a
 * halt on one malformed event (see docs/projection-checkpoint-replay.md,
 * "Failure behavior").
 */
export function toArenaProjectionEvent(
  raw: rpc.Api.EventResponse,
): ArenaProjectionEvent {
  const base = {
    id: raw.id,
    contractId: raw.contractId?.toString() ?? "",
    ledgerSequence: raw.ledger,
    ledgerClosedAt: raw.ledgerClosedAt,
    txHash: raw.txHash,
  };

  const rawTopicSymbol = raw.topic[0];
  let topicValue: unknown;
  try {
    topicValue = rawTopicSymbol !== undefined ? scValToNative(rawTopicSymbol) : undefined;
  } catch (error) {
    return {
      ...base,
      topic: "UNKNOWN",
      rawTopic: null,
      reason: `Failed to decode topic symbol: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const topicString = typeof topicValue === "string" ? topicValue : String(topicValue ?? "");

  if (!isArenaEventTopic(topicString)) {
    return {
      ...base,
      topic: "UNKNOWN",
      rawTopic: topicString || null,
      reason: `Unrecognized event topic (expected one of ${ARENA_EVENT_TOPICS.join(", ")})`,
    };
  }

  try {
    const value = scValToNative(raw.value);

    switch (topicString) {
      case "INIT":
        return { ...base, topic: "INIT", admin: String(value) };
      case "CFGD":
        return { ...base, topic: "CFGD" };
      case "START":
        return { ...base, topic: "START" };
      case "FINISH":
        return { ...base, topic: "FINISH" };
      case "JOIN":
        return { ...base, topic: "JOIN", player: String(value) };
      case "CHOICE":
        return { ...base, topic: "CHOICE", player: String(value) };
      case "ELIM":
        return { ...base, topic: "ELIM", player: String(value) };
      case "CLAIMED":
        return { ...base, topic: "CLAIMED", winner: String(value) };
      case "RWAYLD":
        // i128 decodes to a bigint via scValToNative; stringify to preserve
        // precision (see ArenaProjectionState.totalYieldStroops).
        return {
          ...base,
          topic: "RWAYLD",
          amount: typeof value === "bigint" ? value.toString() : String(value),
        };
      default: {
        // Exhaustiveness guard — isArenaEventTopic already narrowed
        // topicString to ArenaEventTopic, so this is unreachable, but keeps
        // the decoder from silently swallowing a future topic added to
        // ARENA_EVENT_TOPICS without a case here.
        const _exhaustive: never = topicString;
        return {
          ...base,
          topic: "UNKNOWN",
          rawTopic: _exhaustive,
          reason: "Topic recognized by isArenaEventTopic but missing a decoder case",
        };
      }
    }
  } catch (error) {
    return {
      ...base,
      topic: "UNKNOWN",
      rawTopic: topicString,
      reason: `Failed to decode event payload: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Default page size for a single `getEvents` RPC call (#1382). */
export const DEFAULT_ARENA_EVENT_PAGE_SIZE = 1000;

/**
 * Fetch a single page of on-chain events for an arena contract, starting
 * either at `startLedger` (genesis/first page) or continuing from a prior
 * page's `cursor`. Exactly one of `startLedger`/`cursor` should be provided,
 * mirroring the underlying RPC contract (cursor-based pagination cannot be
 * combined with a ledger start point).
 *
 * This performs exactly one RPC call — batching/looping across pages and
 * retry policy belong to the replay engine
 * (`services/projection/arenaProjectionReplay.ts`), not here, so this
 * function stays a thin, testable I/O boundary.
 *
 * @throws OnChainReadError on any RPC failure — callers must not treat a
 *   failed fetch as "no events" (that would silently truncate replay).
 */
export async function getArenaEvents(
  contractId: string,
  options: { startLedger: number; cursor?: undefined } | { cursor: string; startLedger?: undefined },
  limit: number = DEFAULT_ARENA_EVENT_PAGE_SIZE,
): Promise<ArenaEventPage> {
  const stellarRpcGateway = new StellarRpcGateway();
  try {
    const paginationArg: { cursor: string } | { startLedger: number } =
      "cursor" in options && options.cursor
        ? { cursor: options.cursor }
        : { startLedger: options.startLedger as number };

    const response = await stellarRpcGateway.getEvents({
      filters: [{ type: "contract", contractIds: [contractId] }],
      ...paginationArg,
      limit,
    });

    const events = response.events.map(toArenaProjectionEvent);
    const lastRawEvent = response.events[response.events.length - 1];
    const cursor =
      events.length >= limit && lastRawEvent
        ? lastRawEvent.pagingToken
        : null;

    return {
      events,
      latestLedger: response.latestLedger,
      cursor,
    };
  } catch (error) {
    throw new OnChainReadError("getEvents", contractId, error);
  }
}
