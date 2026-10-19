"use client";

import { useEffect, useState } from "react";
import type { Currency } from "@/shared/lib/form-validation";
import { stellarConfig } from "@/shared/config/stellarConfig";
import { fetchVaultConfig, POOL_TOKEN_IDS } from "@/shared/lib/stellar/stellar-transactions";
import { compatibleCurrencies } from "@/shared/lib/stellar/pool-compatibility";

export type PoolCompatibility =
  /** Vault config not read yet. */
  | { status: "loading"; currencies: null }
  /** Read succeeded: only `currencies` can back a pool (possibly none). */
  | { status: "ready"; currencies: Currency[] }
  /**
   * Read failed (RPC down, vault not configured). The form stays usable;
   * `buildCreatePoolTransaction` re-reads the vault and refuses an
   * incompatible selection before anything is signed.
   */
  | { status: "unavailable"; currencies: null };

/**
 * Which pool currencies the configured yield vault can back (#1634).
 *
 * Reads the vault's `config()` each time the pool creation form opens, so a
 * vault upgraded to a different token is picked up without a redeploy.
 */
export function usePoolCompatibility(isOpen: boolean): PoolCompatibility {
  const [state, setState] = useState<PoolCompatibility>({ status: "loading", currencies: null });

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    // On reopen the previous result stays visible until this read settles;
    // the transaction builder re-checks the vault regardless.
    Promise.resolve()
      .then(() => fetchVaultConfig())
      .then((vault) => {
        if (cancelled) return;
        setState({
          status: "ready",
          currencies: compatibleCurrencies(vault, POOL_TOKEN_IDS, stellarConfig.oracleContractId ?? ""),
        });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "unavailable", currencies: null });
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  return state;
}
