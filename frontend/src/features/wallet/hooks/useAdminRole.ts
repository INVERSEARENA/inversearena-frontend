import { useEffect, useState } from "react";

export type AdminRoleStatus =
  | "idle"
  | "checking"
  | "authorized"
  | "unauthorized"
  | "error";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

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
        const params = new URLSearchParams({ address: publicKey });
        const response = await fetch(
          `${API_BASE}/api/admin/wallet-role?${params.toString()}`,
          { cache: "no-store" },
        );

        if (!response.ok) {
          if (!cancelled) setRoleStatus("error");
          return;
        }

        const data = (await response.json()) as { isAdmin: boolean };
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
