import { useEffect, useState } from "react";
import { apiClient } from "@/shared/lib/api/client";

export type AdminRoleStatus =

/**
 * Server-verified admin role check for a connected wallet.
 *
 * Wallet-connected status alone is not authorization — this asks the backend
 * whether `publicKey` is on the operator allowlist (GET /api/admin/wallet-role)
 * so admin UI and actions can be gated on a real role claim instead of on
 * "some wallet, any wallet, is connected".
 */
export function useAdminRole(publicKey: string | null): AdminRoleStatus {
  const [roleStatus, setRoleStatus] = useState<AdminRoleStatus>("idle");

  useEffect(() => {
    if (!publicKey) return;

    let cancelled = false;

    (async () => {
      setRoleStatus("checking");
      try {
        const data = await apiClient.get<{ isAdmin: boolean }>("/api/admin/wallet-role", {
          params: { address: publicKey },
          cache: "no-store",
        });
        if (!cancelled) setRoleStatus(data.isAdmin ? "authorized" : "unauthorized");
      } catch {
        if (!cancelled) setRoleStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [publicKey]);

  return publicKey ? roleStatus : "idle";
}
