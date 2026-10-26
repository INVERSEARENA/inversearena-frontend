"use client";

import { useEffect, useState } from "react";
import {
  fetchRegistryLifecycle,
  type RegistryLifecycleSnapshot,
} from "@/shared/lib/stellar/registry-lifecycle";

/**
 * The registry lifecycle of the integrations a pool is built on (#1688).
 *
 * The snapshot is read when the form opens and refreshed whenever the
 * selected integration changes, so a deprecation announced while the form
 * was open is picked up before the creator signs. A failed read yields an
 * unavailable snapshot whose entries read as `Active` — a read outage must
 * never look like a deprecation.
 */
export function useRegistryLifecycle(input: {
  enabled: boolean;
  token?: string | undefined;
  vault?: string | undefined;
  oracle?: string | undefined;
}): RegistryLifecycleSnapshot {
  const [snapshot, setSnapshot] = useState<RegistryLifecycleSnapshot>({
    revision: 0,
    available: false,
    entries: [],
  });

  const { enabled, token, vault, oracle } = input;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchRegistryLifecycle({ token, vault, oracle })
      .then((next) => {
        if (!cancelled) setSnapshot(next);
      })
      .catch(() => {
        if (!cancelled) setSnapshot({ revision: 0, available: false, entries: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, token, vault, oracle]);

  return snapshot;
}
