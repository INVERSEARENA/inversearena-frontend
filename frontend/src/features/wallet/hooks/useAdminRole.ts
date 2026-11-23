import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/lib/api/client";
import { queryKeys } from "@/shared/lib/query/queryClient";

export type AdminRoleStatus =
  | "idle"
  | "checking"
  | "authorized"
  | "unauthorized"
  | "error";

/**
 * Server-verified admin role check for a connected wallet (#1769).
 */
export function useAdminRole(publicKey: string | null): AdminRoleStatus {
  const query = useQuery({
    queryKey: queryKeys.wallet.admin(publicKey),
    queryFn: async () => {
      if (!publicKey) return false;
      const data = await apiClient.get<{ isAdmin: boolean }>("/api/admin/wallet-role", {
        params: { address: publicKey },
      });
      return Boolean(data?.isAdmin);
    },
    enabled: Boolean(publicKey),
  });

  if (!publicKey) return "idle";
  if (query.isLoading) return "checking";
  if (query.isError) return "error";
  return query.data ? "authorized" : "unauthorized";
}
