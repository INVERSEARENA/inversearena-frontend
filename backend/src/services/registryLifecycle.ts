/**
 * Registry deprecation lifecycle, read from the factory contract (#1688).
 *
 * The factory's registry used to be binary: a token, vault or oracle was
 * either approved or not. The lifecycle adds the middle state — a
 * `Deprecated` integration is no longer accepted for *new* arenas, while the
 * arenas that already use it stay readable and settleable.
 *
 * This module is the backend's single reader for that state. It answers two
 * questions:
 *
 *  - what is the lifecycle state of an integration? (`Active`, `Deprecated`
 *    or `Disabled`), and
 *  - what is the current registry revision? The revision is bumped by the
 *    contract on every lifecycle change and is the cache-invalidation key:
 *    a cached snapshot whose revision no longer matches the on-chain one is
 *    stale and must be rebuilt.
 *
 * Failure semantics: a factory that cannot answer — an RPC failure, or a
 * deployment that predates the lifecycle views — is reported as
 * `available: false` with every entry reading as `Active`. That is the same
 * rule the contract applies to an entry it has no record of (an unknown
 * legacy entry): the integration is treated as active rather than silently
 * withdrawn, so a read outage can never look like a deprecation.
 */
import { Address } from "@stellar/stellar-sdk";
import { env } from "../config/env";
import { readContractView } from "./onChainReader";

/** Mirrors the factory contract's `RegistryState` enum (#1688). */
export type RegistryLifecycleState = "Active" | "Deprecated" | "Disabled";

/** Which registry an entry belongs to (#1688). */
export type RegistryKind = "token" | "vault" | "oracle";

/** One integration's lifecycle record. */
export interface RegistryLifecycleEntry {
  kind: RegistryKind;
  address: string;
  state: RegistryLifecycleState;
  /** Ledger timestamp at which the state took effect (`0` = legacy entry). */
  effectiveLedger: number;
  /** Machine-readable reason for the transition. */
  reason: string;
}

/** A snapshot of the registry, stamped with the revision it was read at. */
export interface RegistryLifecycleSnapshot {
  /** The contract's registry revision — the cache-invalidation key. */
  revision: number;
  /** `false` when the factory could not be read at all. */
  available: boolean;
  entries: RegistryLifecycleEntry[];
}

/** The factory's view function for each kind of registry entry. */
const LIFECYCLE_VIEW: Record<RegistryKind, string> = {
  token: "get_token_lifecycle",
  vault: "get_vault_lifecycle",
  oracle: "get_oracle_lifecycle",
};

/** How long a snapshot is served before it is re-read. */
const CACHE_TTL_MS = 30_000;

const VALID_STATES: RegistryLifecycleState[] = ["Active", "Deprecated", "Disabled"];

interface CachedSnapshot {
  snapshot: RegistryLifecycleSnapshot;
  fetchedAt: number;
}

const cache = new Map<string, CachedSnapshot>();

/** Test seam — clears the cached snapshots. */
export function resetRegistryLifecycleCacheForTest(): void {
  cache.clear();
}

/**
 * Decode the factory's `RegistryEntry` struct.
 *
 * A fieldless Rust enum is encoded as a one-element ScVec, so the decoded
 * state arrives as `["Deprecated"]` rather than `"Deprecated"` — the same
 * shape quirk the arena metadata decoder documents.
 */
function decodeEntry(
  kind: RegistryKind,
  address: string,
  raw: unknown,
): RegistryLifecycleEntry {
  const record = (raw ?? {}) as Record<string, unknown>;
  const stateRaw = Array.isArray(record.state) ? record.state[0] : record.state;
  const state = VALID_STATES.find((candidate) => candidate === stateRaw);
  return {
    kind,
    address,
    // An unrecognised state is treated as active rather than as a
    // withdrawal: the contract only ever returns the three states above, so
    // this can only be a decoding problem, not a protocol decision.
    state: state ?? "Active",
    effectiveLedger: Number(record.effective_ledger ?? 0),
    reason: String(record.reason ?? "legacy"),
  };
}

/**
 * Read the factory's registry revision.
 *
 * Returns `0` when the factory cannot answer — a deployment that predates
 * the lifecycle, or an RPC failure. `0` is also the revision of a factory
 * that has never changed a lifecycle, so a client cannot tell the two apart
 * and must fall back to the entry states themselves.
 */
export async function readRegistryRevision(factoryContractId?: string): Promise<number> {
  const contractId = factoryContractId ?? env.ARENA_FACTORY_CONTRACT_ID;
  if (!contractId) return 0;
  try {
    const value = await readContractView(contractId, "get_registry_revision");
    return Number(value as bigint | number);
  } catch {
    return 0;
  }
}

/**
 * Read the lifecycle of the requested integrations.
 *
 * Returns one entry per requested address, in the order the addresses were
 * given. Integrations the factory has no record of read as `Active` with
 * ledger `0` and reason `legacy` — the same rule the contract applies.
 */
export async function readRegistryLifecycle(input: {
  token?: string | undefined;
  vault?: string | undefined;
  oracle?: string | undefined;
}): Promise<RegistryLifecycleSnapshot> {
  const contractId = env.ARENA_FACTORY_CONTRACT_ID;
  const requested: Array<{ kind: RegistryKind; address: string }> = [];
  if (input.token) requested.push({ kind: "token", address: input.token });
  if (input.vault) requested.push({ kind: "vault", address: input.vault });
  if (input.oracle) requested.push({ kind: "oracle", address: input.oracle });

  if (!contractId || requested.length === 0) {
    return {
      revision: 0,
      available: false,
      entries: requested.map(({ kind, address }) => ({
        kind,
        address,
        state: "Active" as RegistryLifecycleState,
        effectiveLedger: 0,
        reason: "unavailable",
      })),
    };
  }

  const cacheKey = requested.map((entry) => `${entry.kind}:${entry.address}`).join("|");
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.snapshot;
  }

  const revision = await readRegistryRevision(contractId);
  const entries = await Promise.all(
    requested.map(async ({ kind, address }) => {
      try {
        const raw = await readContractView(contractId, LIFECYCLE_VIEW[kind], [
          new Address(address).toScVal(),
        ]);
        return decodeEntry(kind, address, raw);
      } catch {
        // The factory could not answer for this entry: treat it as active
        // (an unknown legacy entry), never as withdrawn.
        return {
          kind,
          address,
          state: "Active" as RegistryLifecycleState,
          effectiveLedger: 0,
          reason: "unavailable",
        };
      }
    }),
  );

  const snapshot: RegistryLifecycleSnapshot = { revision, available: revision > 0, entries };
  cache.set(cacheKey, { snapshot, fetchedAt: Date.now() });
  return snapshot;
}

/**
 * The lifecycle state of one integration in a snapshot.
 *
 * An integration that is not in the snapshot reads as `Active` — an unknown
 * legacy entry is active, and a snapshot that could not be read must not
 * look like a deprecation.
 */
export function lifecycleStateOf(
  snapshot: RegistryLifecycleSnapshot | null,
  kind: RegistryKind,
  address: string | undefined,
): RegistryLifecycleState {
  if (!snapshot || !address) return "Active";
  const entry = snapshot.entries.find((candidate) => candidate.kind === kind && candidate.address === address);
  return entry?.state ?? "Active";
}
