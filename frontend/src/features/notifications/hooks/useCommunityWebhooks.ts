"use client";

import { useCallback, useEffect, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export interface CommunityWebhook {
  id: string;
  arenaId: string;
  name: string | null;
  urlMasked: string;
  active: boolean;
  createdAt: string;
}

function authHeaders(): HeadersInit {
  const token =
    typeof window !== "undefined" ? window.localStorage.getItem("access_token") : null;
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

/** Host-only community webhook management for arena announcements (#1735). */
export function useCommunityWebhooks(arenaId: string) {
  const [webhooks, setWebhooks] = useState<CommunityWebhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!arenaId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/arenas/${arenaId}/notification-webhooks`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as { items: CommunityWebhook[] };
      setWebhooks(body.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load webhooks");
    } finally {
      setLoading(false);
    }
  }, [arenaId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addWebhook = useCallback(
    async (url: string, name?: string) => {
      setError(null);
      const res = await fetch(`${API_BASE}/api/arenas/${arenaId}/notification-webhooks`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ url, ...(name ? { name } : {}) }),
      });
      if (!res.ok) throw new Error(await readError(res));
      await refresh();
    },
    [arenaId, refresh],
  );

  const removeWebhook = useCallback(
    async (webhookId: string) => {
      setError(null);
      const res = await fetch(
        `${API_BASE}/api/arenas/${arenaId}/notification-webhooks/${webhookId}`,
        { method: "DELETE", headers: authHeaders() },
      );
      if (!res.ok) throw new Error(await readError(res));
      await refresh();
    },
    [arenaId, refresh],
  );

  const announce = useCallback(
    async (title?: string, body?: string) => {
      setError(null);
      const res = await fetch(`${API_BASE}/api/arenas/${arenaId}/announcements`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          ...(title ? { title } : {}),
          ...(body ? { body } : {}),
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      return (await res.json()) as { delivered: number; failed: number; retrying: number; skipped: number };
    },
    [arenaId],
  );

  return { webhooks, loading, error, refresh, addWebhook, removeWebhook, announce };
}
