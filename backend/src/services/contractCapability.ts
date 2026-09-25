/**
 * Contract capability negotiation across mixed deployment versions (#1409).
 *
 * Inverse Arena deploys arena/factory/payout/staking contract instances
 * over time, and an upgraded contract's WASM can add new entrypoints or
 * change existing behavior. Two instances of the same contract kind can be
 * live at once on different versions (an old arena still running its round
 * out, a new arena created after an upgrade), so callers cannot assume every
 * deployed instance supports every entrypoint the current TypeScript code
 * knows about.
 *
 * This module is the single place that answers "is entrypoint X callable on
 * this specific deployed contract instance": it reads the instance's
 * on-chain `version()`, maps that to the entrypoint set the capability map
 * below declares as available at-or-above that version, and caches the
 * result so hot paths (e.g. a route handler called on every request) don't
 * re-read RPC per call.
 *
 * State semantics: negotiation result is a per-contract-instance fact,
 * cached by `${contractKind}:${contractId}` for CACHE_TTL_MS. A version read
 * failure does not get cached (a transient RPC blip shouldn't poison the
 * cache for the TTL window) and is retried with backoff before surfacing to
 * the caller as CapabilityNegotiationError.
 *
 * Compatibility: unsupported entrypoints are hidden via
 * `isEntrypointSupported`/`assertEntrypointSupported`, not by attempting the
 * call and interpreting a contract-level error - Soroban has no reliable
 * "method not found" signal distinct from other simulation failures, so
 * negotiating up front is the only way to fail predictably instead of
 * surfacing a raw RPC error deep in an unrelated code path.
 */
import { logger } from "../utils/logger";
import { getSorobanBreaker, CircuitOpenError, type CircuitBreaker } from "../utils/circuitBreaker";
import {
  capabilityNegotiationsTotal,
  capabilityNegotiationDuration,
  capabilityCacheHitsTotal,
} from "../utils/metrics";

export type ContractKind = "arena" | "factory" | "payout" | "staking";

/**
 * Entrypoints this codebase may call on each contract kind, and the lowest
 * on-chain contract version that exposes them. An entrypoint absent from a
 * kind's map is treated as always-supported (present since version 1) -
 * only entrypoints added after a kind's initial release need an entry here.
 *
 * Update this map (and bump the corresponding contract's CONTRACT_VERSION,
 * contract/<kind>/src/lib.rs) whenever a new entrypoint is added to a
 * contract that older deployed instances won't have.
 */
let capabilityMap: Record<ContractKind, Record<string, number>> = {
  arena: {},
  factory: {},
  payout: {},
  staking: {},
};

/**
 * Test seam - overrides the capability map so tests can exercise real
 * version-gating without depending on production entrypoint data changing
 * over time. Pass null to restore the default (empty) map.
 */
export function setCapabilityMapForTest(
  map: Record<ContractKind, Record<string, number>> | null,
): void {
  capabilityMap = map ?? { arena: {}, factory: {}, payout: {}, staking: {} };
}

/**
 * Lowest on-chain contract version that exposes `entrypoint`, or undefined
 * when it has no capability map entry (available since version 1). Lets the
 * compatibility manifest (#1491) evaluate support from versions it already
 * negotiated instead of negotiating again per entrypoint.
 */
export function getRequiredCapabilityVersion(
  kind: ContractKind,
  entrypoint: string,
): number | undefined {
  return capabilityMap[kind][entrypoint];
}

const CACHE_TTL_MS = 5 * 60_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 100;

export class CapabilityNegotiationError extends Error {
  constructor(
    readonly contractKind: ContractKind,
    readonly contractId: string,
    override readonly cause?: unknown,
  ) {
    super(
      `Capability negotiation failed for ${contractKind} contract ${contractId}: ` +
        (cause instanceof Error ? cause.message : String(cause)),
    );
    this.name = "CapabilityNegotiationError";
  }
}

export class UnsupportedEntrypointError extends Error {
  constructor(
    readonly contractKind: ContractKind,
    readonly contractId: string,
    readonly entrypoint: string,
    readonly deployedVersion: number,
    readonly requiredVersion: number,
  ) {
    super(
      `${entrypoint} requires ${contractKind} contract version >= ${requiredVersion}, ` +
        `but ${contractId} is deployed at version ${deployedVersion}`,
    );
    this.name = "UnsupportedEntrypointError";
  }
}

interface NegotiatedCapability {
  version: number;
  fetchedAt: number;
}

const cache = new Map<string, NegotiatedCapability>();
let breakerOverride: CircuitBreaker | null = null;
let versionReaderOverride: ((contractId: string) => Promise<number>) | null = null;

/** Test seam - overrides the on-chain version reader without touching RPC. */
export function setVersionReaderForTest(
  reader: ((contractId: string) => Promise<number>) | null,
): void {
  versionReaderOverride = reader;
}

export function setCircuitBreakerForTest(breaker: CircuitBreaker | null): void {
  breakerOverride = breaker;
}

export function resetCapabilityCacheForTest(): void {
  cache.clear();
}

function cacheKey(kind: ContractKind, contractId: string): string {
  return `${kind}:${contractId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Lazily imports getOnChainContractVersion only when actually needed. A
 * static top-level import would drag in onChainReader.ts's transitive
 * dependency on the frontend package's `@/` path-aliased imports, which
 * the backend's module resolution does not support (a pre-existing,
 * repo-wide gap, not something #1409 introduces or should silently patch).
 * Deferring the import means production code (which does need the real
 * reader) still works via the backend's own runtime module resolution,
 * while tests - which always inject a reader via setVersionReaderForTest -
 * never trigger this import at all.
 */
async function defaultVersionReader(contractId: string): Promise<number> {
  const { getOnChainContractVersion } = await import("./onChainReader");
  return getOnChainContractVersion(contractId);
}

async function readVersionWithRetry(
  kind: ContractKind,
  contractId: string,
): Promise<number> {
  const reader = versionReaderOverride ?? defaultVersionReader;
  const breaker = breakerOverride ?? getSorobanBreaker();

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await breaker.fire(() => reader(contractId));
    } catch (error) {
      lastError = error;
      // The circuit itself is open: retrying immediately would just keep
      // failing until the breaker's own reset timeout elapses, so stop
      // instead of burning through the retry budget on a call that cannot
      // succeed yet.
      if (error instanceof CircuitOpenError) {
        break;
      }
      capabilityNegotiationsTotal.inc({ contract: kind, outcome: "retry" });
      logger.warn(
        {
          event: "capability_negotiation_retry",
          contract: kind,
          contractId,
          attempt,
          maxRetries: MAX_RETRIES,
          errorName: error instanceof Error ? error.name : typeof error,
        },
        "Contract version read failed, retrying",
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
}

/**
 * Negotiate (and cache) the capability set for a specific deployed contract
 * instance. Returns the on-chain version actually read.
 */
export async function negotiateCapability(
  kind: ContractKind,
  contractId: string,
): Promise<number> {
  const key = cacheKey(kind, contractId);
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    capabilityCacheHitsTotal.inc({ contract: kind });
    return cached.version;
  }

  const started = process.hrtime.bigint();
  try {
    const version = await readVersionWithRetry(kind, contractId);
    cache.set(key, { version, fetchedAt: now });
    capabilityNegotiationsTotal.inc({ contract: kind, outcome: "success" });
    logger.info(
      { event: "capability_negotiation_success", contract: kind, contractId, version },
      "Contract capability negotiated",
    );
    return version;
  } catch (error) {
    capabilityNegotiationsTotal.inc({ contract: kind, outcome: "failure" });
    logger.error(
      {
        event: "capability_negotiation_failure",
        contract: kind,
        contractId,
        errorName: error instanceof Error ? error.name : typeof error,
      },
      "Contract capability negotiation failed",
    );
    throw new CapabilityNegotiationError(kind, contractId, error);
  } finally {
    const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000_000;
    capabilityNegotiationDuration.observe({ contract: kind }, Math.max(0, elapsed));
  }
}

/**
 * True if `entrypoint` is callable on the given deployed contract instance,
 * per its negotiated on-chain version. Entrypoints with no capability map
 * entry are always supported.
 */
export async function isEntrypointSupported(
  kind: ContractKind,
  contractId: string,
  entrypoint: string,
): Promise<boolean> {
  const requiredVersion = capabilityMap[kind][entrypoint];
  if (requiredVersion === undefined) return true;

  const version = await negotiateCapability(kind, contractId);
  return version >= requiredVersion;
}

/**
 * Throws UnsupportedEntrypointError instead of returning a boolean, for
 * call sites that want the unsupported case to hide the entrypoint (abort
 * the caller's operation with a clear reason) rather than branch on it.
 */
export async function assertEntrypointSupported(
  kind: ContractKind,
  contractId: string,
  entrypoint: string,
): Promise<void> {
  const requiredVersion = capabilityMap[kind][entrypoint];
  if (requiredVersion === undefined) return;

  const version = await negotiateCapability(kind, contractId);
  if (version < requiredVersion) {
    throw new UnsupportedEntrypointError(kind, contractId, entrypoint, version, requiredVersion);
  }
}
