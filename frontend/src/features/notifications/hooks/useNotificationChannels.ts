"use client";

import { useCallback, useEffect, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export const NOTIFICATION_EVENTS = [
  "round",
  "payout",
  "elimination",
  "rematch",
  "arena_announcement",
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export const USER_NOTIFICATION_CHANNELS = ["push", "telegram", "discord", "in_app"] as const;
export type UserNotificationChannel = (typeof USER_NOTIFICATION_CHANNELS)[number];

export interface ChannelPreference {
  eventType: NotificationEvent;
  channel: string;
  enabled: boolean;
}

export interface LinkedChannel {
  id: string;
  channel: "telegram" | "discord";
  externalId: string;
  displayName: string | null;
  active: boolean;
  linkedAt: string;
}

export interface ChannelPreferencesPayload {
  preferences: {
    userId: string;
    emailEnabled: boolean;
    pushEnabled: boolean;
    telegramEnabled: boolean;
    discordEnabled: boolean;
    inAppEnabled: boolean;
    roundNotifications: boolean;
    payoutNotifications: boolean;
    eliminationNotifications: boolean;
    arenaAnnouncementNotifications: boolean;
  };
  channelPreferences: ChannelPreference[];
  links: LinkedChannel[];
}

export interface LinkCodeResponse {
  channel: "telegram" | "discord";
  code: string;
  expiresAt: string;
  instructions: string;
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

export function useNotificationChannels() {
  const [data, setData] = useState<ChannelPreferencesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linkCode, setLinkCode] = useState<LinkCodeResponse | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/users/me/notification-channels`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(await readError(res));
      setData((await res.json()) as ChannelPreferencesPayload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load notification channels");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateSettings = useCallback(
    async (updates: Record<string, unknown>) => {
      setError(null);
      const res = await fetch(`${API_BASE}/api/users/me/notification-channels`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error(await readError(res));
      const next = (await res.json()) as Pick<
        ChannelPreferencesPayload,
        "preferences" | "channelPreferences"
      >;
      setData((current) => (current ? { ...current, ...next } : current));
    },
    [],
  );

  const setChannelEvent = useCallback(
    (eventType: NotificationEvent, channel: string, enabled: boolean) =>
      updateSettings({ channelPreferences: [{ eventType, channel, enabled }] }),
    [updateSettings],
  );

  const createLinkCode = useCallback(async (channel: "telegram" | "discord") => {
    setError(null);
    const res = await fetch(`${API_BASE}/api/users/me/notification-links/${channel}/code`, {
      method: "POST",
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(await readError(res));
    const next = (await res.json()) as LinkCodeResponse;
    setLinkCode(next);
    return next;
  }, []);

  const unlink = useCallback(
    async (channel: "telegram" | "discord") => {
      setError(null);
      const res = await fetch(`${API_BASE}/api/users/me/notification-links/${channel}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(await readError(res));
      await refresh();
    },
    [refresh],
  );

  return {
    data,
    loading,
    error,
    linkCode,
    refresh,
    updateSettings,
    setChannelEvent,
    createLinkCode,
    unlink,
  };
}
