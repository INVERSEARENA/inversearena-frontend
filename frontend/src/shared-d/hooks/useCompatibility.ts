"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { stellarConfig } from "@/lib/stellarConfig";
import {
  compatibilityStore,
  type CapabilityDecision,
  type CapabilityName,
  type CompatibilityStore,
} from "@/shared-d/utils/compatibility-store";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
const REFRESH_INTERVAL_MS = 60_000;
const CONTRACT_ID_REGEX = /^C[A-Z2-7]{55}$/;

/**
 * Fetches the compatibility manifest for a scope (an arena contract id, or
 * null for the deployment wide one) into the store (#1491). Uses normal HTTP
 * caching: the backend marks responses cacheable for a few seconds and stamps
 * them with a configRevision the store uses to reject stale manifests.
 *
 * A 404 means the backend predates the endpoint (new frontend, old backend).
 * Any other failure leaves the previous manifest in place; it stops being
 * trusted once it exceeds MANIFEST_MAX_AGE_MS.
 */
export async function refreshCompatibility(
  scope: string | null,
  store: CompatibilityStore = compatibilityStore,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): Promise<void> {
  let passphrase: string;
  try {
    passphrase = stellarConfig.passphrase;
  } catch {
    return; // Stellar is not configured; nothing can be signed anyway.
  }

  const query = scope ? `?arenaId=${encodeURIComponent(scope)}` : "";
  try {
    const response = await fetchFn(`${API_BASE}/api/config/compatibility${query}`);
    if (response.status === 404) {
      store.markLegacyBackend(scope);
      return;
    }
    if (!response.ok) return;
    store.applyResponse(scope, await response.json(), passphrase);
  } catch {
    // Network failure or a non-JSON body: keep whatever was known.
  }
}

/** Keeps the compatibility manifest for `scope` fresh while the component is mounted. */
export function useCompatibilitySync(
  scope: string | null = null,
  store: CompatibilityStore = compatibilityStore,
): void {
  useEffect(() => {
    if (scope !== null && !CONTRACT_ID_REGEX.test(scope)) return;

    void refreshCompatibility(scope, store);
    const interval = setInterval(() => {
      void refreshCompatibility(scope, store);
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [scope, store]);
}

/** Current decision for a capability, for disabling controls and explaining why. */
export function useCapability(
  name: CapabilityName,
  scope: string | null = null,
  store: CompatibilityStore = compatibilityStore,
): CapabilityDecision {
  const version = useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` is the change signal for the store contents
  return useMemo(() => store.getDecision(name, scope), [store, name, scope, version]);
}

/** Loads the deployment wide manifest at startup and keeps it fresh; mounted once in ClientProviders. */
export function CompatibilitySync(): null {
  useCompatibilitySync(null);
  return null;
}
