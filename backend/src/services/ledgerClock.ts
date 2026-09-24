/**
 * Shared "what ledger are we on" reader, used by:
 *  - maintenanceService (#1399): derives scheduled/active/completed against a
 *    ledger boundary rather than wall-clock time, since the announced
 *    boundary is a ledger sequence.
 *  - arenaStatsService (#1408): stamps a "last verified" on-chain snapshot
 *    with the ledger it was read at, so a degraded response can say exactly
 *    how stale it is.
 *
 * Goes through the shared Soroban circuit breaker so a sustained RPC outage
 * fails fast (CircuitOpenError, 503) instead of every caller hammering RPC
 * independently — consistent with how arenaPoller/paymentService already
 * treat Soroban unavailability.
 */
// @ts-ignore
import { rpc } from "@stellar/stellar-sdk";
const { Server } = rpc;
import { getSorobanBreaker, type CircuitBreaker } from "../utils/circuitBreaker";

let rpcServer: rpc.Server | null = null;
let breakerOverride: CircuitBreaker | null = null;

function getRpcServer(): rpc.Server {
  if (!rpcServer) {
    const url = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
    rpcServer = new Server(url, { allowHttp: false });
  }
  return rpcServer;
}

/** Test seam — mirrors the pattern used in arenaService.ts. */
export function setRpcServerForTest(server: rpc.Server | null): void {
  rpcServer = server;
  cached = null;
}

export function setCircuitBreakerForTest(breaker: CircuitBreaker | null): void {
  breakerOverride = breaker;
}

let cached: { sequence: number; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5_000;

export function resetLedgerClockCacheForTest(): void {
  cached = null;
}

/**
 * Current Soroban ledger sequence, cached for a few seconds. Ledgers close
 * roughly every 5s on both testnet and mainnet, so re-fetching on every
 * caller (a maintenance check on every mutating request, a stats read on
 * every poll) would add RPC load with no real precision gain — a maintenance
 * boundary announced in ledgers is inherently a multi-second-granularity
 * concept.
 */
export async function getCurrentLedgerSequence(): Promise<number> {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.sequence;
  }
  const breaker = breakerOverride ?? getSorobanBreaker();
  const server = getRpcServer();
  const latest = await breaker.fire(() => server.getLatestLedger());
  cached = { sequence: latest.sequence, fetchedAt: now };
  return latest.sequence;
}
