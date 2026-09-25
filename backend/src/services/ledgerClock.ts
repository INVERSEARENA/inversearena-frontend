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
import { logger } from "../utils/logger";
import type { LedgerIdentity } from "./ledgerContinuity";

let rpcServer: rpc.Server | null = null;
let breakerOverride: CircuitBreaker | null = null;

let ledgerObserver: ((identity: LedgerIdentity) => Promise<unknown>) | null = null;

/**
 * Installs the continuity detector that sees every fresh ledger read (#1490).
 * Injected rather than imported so this module keeps no Redis dependency.
 */
export function setLedgerObserver(observer: ((identity: LedgerIdentity) => Promise<unknown>) | null): void {
  ledgerObserver = observer;
}

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

let cached: { identity: LedgerIdentity; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5_000;

export function resetLedgerClockCacheForTest(): void {
  cached = null;
}

/**
 * Current Soroban ledger identity (sequence + hash), cached for a few
 * seconds. Ledgers close roughly every 5s on both testnet and mainnet, so
 * re-fetching on every caller (a maintenance check on every mutating
 * request, a stats read on every poll) would add RPC load with no real
 * precision gain — a maintenance boundary announced in ledgers is inherently
 * a multi-second-granularity concept.
 *
 * Every fresh read is handed to the continuity detector (#1490); a failure
 * inside the detector never fails the read itself.
 */
export async function getCurrentLedgerIdentity(): Promise<LedgerIdentity> {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.identity;
  }
  const breaker = breakerOverride ?? getSorobanBreaker();
  const server = getRpcServer();
  const latest = await breaker.fire(() => server.getLatestLedger());
  const identity: LedgerIdentity = { sequence: latest.sequence, hash: latest.id };
  cached = { identity, fetchedAt: now };
  if (ledgerObserver) {
    try {
      await ledgerObserver(identity);
    } catch (error) {
      logger.error(
        { event: "ledger_continuity_observe_failed", errorName: error instanceof Error ? error.name : typeof error },
        "Ledger continuity observation failed",
      );
    }
  }
  return identity;
}

/** Current Soroban ledger sequence; see {@link getCurrentLedgerIdentity} for caching semantics. */
export async function getCurrentLedgerSequence(): Promise<number> {
  return (await getCurrentLedgerIdentity()).sequence;
}

/**
 * Best-effort ledger read for consumers that only need the continuity
 * detector to have seen the latest ledger before they decide whether to
 * publish (#1490). An unreachable RPC is not this caller's error to raise -
 * its own reads report that - so failures are swallowed here.
 */
export async function refreshLedgerIdentity(): Promise<void> {
  // Nothing consumes the read unless a continuity detector is installed.
  if (!ledgerObserver) return;
  try {
    await getCurrentLedgerIdentity();
  } catch {
    // Reported by the consumer's own RPC reads.
  }
}
