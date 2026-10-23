/**
 * Registry deprecation lifecycle, surfaced to clients (#1688).
 *
 * The factory's registry used to be binary: a stake token, yield vault or
 * oracle was either approved or not, so an integration that already backed
 * live arenas could only stay approved or be pulled out from under them.
 * The lifecycle adds the middle state:
 *
 *  - `Active` — usable for new arenas and fully supported for existing ones.
 *  - `Deprecated` — no longer accepted for new arenas, but the arenas that
 *    already use it stay readable and settleable.
 *  - `Disabled` — not usable at all; only reachable once every liability is
 *    settled.
 *
 * A client that sees `Deprecated` must say so — for a creator, before they
 * sign; for a player, as an explanation, never as "unsupported": the arena
 * they are in still settles.
 *
 * The snapshot carries the factory's registry revision, which moves on every
 * lifecycle change. A cached snapshot whose revision no longer matches the
 * one the backend reports is stale.
 */
import type { Currency } from "@/shared/lib/form-validation";

/** Mirrors the factory contract's `RegistryState` enum (#1688). */
export type RegistryLifecycleState = "Active" | "Deprecated" | "Disabled";

/** Which registry an entry belongs to (#1688). */
export type RegistryLifecycleKind = "token" | "vault" | "oracle";

/** One integration's lifecycle record. */
export interface RegistryLifecycleEntry {
  kind: RegistryLifecycleKind;
  address: string;
  state: RegistryLifecycleState;
  /** Ledger timestamp at which the state took effect (`0` = legacy entry). */
  effectiveLedger: number;
  reason: string;
}

/** A snapshot of the registry, stamped with the revision it was read at. */
export interface RegistryLifecycleSnapshot {
  /** The factory's registry revision — the cache-invalidation key. */
  revision: number;
  /** `false` when the factory could not be read at all. */
  available: boolean;
  entries: RegistryLifecycleEntry[];
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

/**
 * Read the lifecycle of the given integrations.
 *
 * A failed read resolves to an unavailable snapshot whose entries read as
 * `Active`: an integration that cannot be checked must never be presented as
 * withdrawn.
 */
export async function fetchRegistryLifecycle(input: {
  token?: string | undefined;
  vault?: string | undefined;
  oracle?: string | undefined;
}): Promise<RegistryLifecycleSnapshot> {
  const params = new URLSearchParams();
  if (input.token) params.set("token", input.token);
  if (input.vault) params.set("vault", input.vault);
  if (input.oracle) params.set("oracle", input.oracle);
  if (!params.toString()) {
    return { revision: 0, available: false, entries: [] };
  }

  try {
    const response = await fetch(`${API_BASE}/api/config/registry?${params.toString()}`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`registry lifecycle read failed: ${response.status}`);
    const body = (await response.json()) as RegistryLifecycleSnapshot;
    return {
      revision: Number(body.revision ?? 0),
      available: Boolean(body.available),
      entries: Array.isArray(body.entries) ? body.entries : [],
    };
  } catch {
    return { revision: 0, available: false, entries: [] };
  }
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
  kind: RegistryLifecycleKind,
  address: string | undefined,
): RegistryLifecycleState {
  if (!snapshot || !address) return "Active";
  const entry = snapshot.entries.find(
    (candidate) => candidate.kind === kind && candidate.address === address,
  );
  return entry?.state ?? "Active";
}

/**
 * The message a creator must see before signing, or `null` when the
 * integration can still be used for a new arena.
 *
 * A deprecated integration is refused by the factory, so the creator is told
 * before they sign rather than after the transaction is rejected.
 */
export function creatorLifecycleWarning(
  snapshot: RegistryLifecycleSnapshot | null,
  integrations: { token?: string | undefined; vault?: string | undefined; oracle?: string | undefined },
  labels: { token?: string | undefined; vault?: string | undefined; oracle?: string | undefined },
): string | null {
  const checks: Array<[RegistryLifecycleKind, string | undefined, string | undefined]> = [
    ["token", integrations.token, labels.token ?? "the stake token"],
    ["vault", integrations.vault, labels.vault ?? "the yield vault"],
    ["oracle", integrations.oracle, labels.oracle ?? "the oracle"],
  ];
  for (const [kind, address, label] of checks) {
    const state = lifecycleStateOf(snapshot, kind, address);
    if (state === "Disabled") {
      return `${label} has been withdrawn by the protocol and can no longer be used for new arenas.`;
    }
    if (state === "Deprecated") {
      return `${label} is deprecated: it still settles the arenas that already use it, but no new arena can be created with it.`;
    }
  }
  return null;
}

/**
 * The message a player sees about a deprecated integration in an arena they
 * are already part of.
 *
 * It never says "unsupported": the arena settles normally, and the
 * deprecation only means no *new* arena can use the integration.
 */
export function playerLifecycleNotice(
  snapshot: RegistryLifecycleSnapshot | null,
  integrations: { token?: string | undefined; vault?: string | undefined; oracle?: string | undefined },
): string | null {
  const deprecated: string[] = [];
  if (lifecycleStateOf(snapshot, "vault", integrations.vault) === "Deprecated") {
    deprecated.push("yield vault");
  }
  if (lifecycleStateOf(snapshot, "oracle", integrations.oracle) === "Deprecated") {
    deprecated.push("oracle");
  }
  if (lifecycleStateOf(snapshot, "token", integrations.token) === "Deprecated") {
    deprecated.push("stake token");
  }
  if (deprecated.length === 0) return null;
  const list = deprecated.length === 1 ? deprecated[0] : `${deprecated.slice(0, -1).join(", ")} and ${deprecated[deprecated.length - 1]}`;
  return `This arena uses a deprecated ${list}. It still settles normally — claims and refunds are supported — but no new arena can be created with it.`;
}

/** The currency's stake token contract id, for a lifecycle lookup. */
export function lifecycleAddressForCurrency(
  currency: Currency,
  tokenIds: Record<Currency, string>,
): string | undefined {
  return tokenIds?.[currency];
}
