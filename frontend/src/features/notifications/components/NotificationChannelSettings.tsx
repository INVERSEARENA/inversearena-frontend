"use client";

import { useMemo, useState } from "react";
import {
  NOTIFICATION_EVENTS,
  USER_NOTIFICATION_CHANNELS,
  useNotificationChannels,
  type NotificationEvent,
} from "../hooks/useNotificationChannels";
import { PushSubscribeButton } from "./PushSubscribeButton";

const CHANNEL_LABELS: Record<string, string> = {
  push: "WEB PUSH",
  telegram: "TELEGRAM",
  discord: "DISCORD",
  in_app: "IN APP",
};

const EVENT_LABELS: Record<NotificationEvent, string> = {
  round: "ROUND PHASES",
  payout: "PAYOUTS",
  elimination: "ELIMINATIONS",
  rematch: "REMATCHES",
  arena_announcement: "ARENA NEWS",
};

const LEGACY_CHANNEL_KEYS: Record<string, "pushEnabled" | "telegramEnabled" | "discordEnabled" | "inAppEnabled"> = {
  push: "pushEnabled",
  telegram: "telegramEnabled",
  discord: "discordEnabled",
  in_app: "inAppEnabled",
};

const LEGACY_EVENT_KEYS: Record<NotificationEvent, "roundNotifications" | "payoutNotifications" | "eliminationNotifications" | "arenaAnnouncementNotifications"> = {
  round: "roundNotifications",
  payout: "payoutNotifications",
  elimination: "eliminationNotifications",
  rematch: "roundNotifications",
  arena_announcement: "arenaAnnouncementNotifications",
};

/** Per-event/per-channel notification preferences plus bot linking (#1735). */
export function NotificationChannelSettings({ className = "" }: { className?: string }) {
  const { data, loading, error, linkCode, setChannelEvent, createLinkCode, unlink } =
    useNotificationChannels();
  const [action, setAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const explicit = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const pref of data?.channelPreferences ?? []) {
      map.set(`${pref.eventType}:${pref.channel}`, pref.enabled);
    }
    return map;
  }, [data?.channelPreferences]);

  const links = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const link of data?.links ?? []) map.set(link.channel, link.active);
    return map;
  }, [data?.links]);

  const effective = (event: NotificationEvent, channel: string): boolean => {
    const key = `${event}:${channel}`;
    if (explicit.has(key)) return explicit.get(key)!;
    if (!data) return false;
    const channelKey = LEGACY_CHANNEL_KEYS[channel];
    const eventKey = LEGACY_EVENT_KEYS[event];
    return Boolean(channelKey && data.preferences[channelKey] && data.preferences[eventKey]);
  };

  const toggle = async (event: NotificationEvent, channel: string, enabled: boolean) => {
    setAction(`${event}:${channel}`);
    setActionError(null);
    try {
      await setChannelEvent(event, channel, enabled);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to update preference");
    } finally {
      setAction(null);
    }
  };

  const link = async (channel: "telegram" | "discord") => {
    setAction(channel);
    setActionError(null);
    try {
      await createLinkCode(channel);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to create link code");
    } finally {
      setAction(null);
    }
  };

  const removeLink = async (channel: "telegram" | "discord") => {
    setAction(channel);
    setActionError(null);
    try {
      await unlink(channel);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to unlink");
    } finally {
      setAction(null);
    }
  };

  return (
    <section className={className} aria-label="Notification channels">
      <h3 className="text-xs font-bold tracking-[0.2em] uppercase text-zinc-300">
        NOTIFICATION CHANNELS
      </h3>
      <div className="mt-4">
        <PushSubscribeButton />
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        {(["telegram", "discord"] as const).map((channel) => (
          <div key={channel} className="border border-white/10 p-3">
            <p className="text-[10px] font-bold tracking-[0.2em] uppercase text-zinc-400">
              {CHANNEL_LABELS[channel]}
            </p>
            {links.get(channel) ? (
              <div className="mt-2 flex items-center gap-3">
                <span className="text-[10px] uppercase text-neon-green">LINKED</span>
                <button
                  type="button"
                  disabled={action === channel}
                  onClick={() => void removeLink(channel)}
                  className="text-[10px] uppercase text-zinc-500 hover:text-neon-pink disabled:opacity-50"
                >
                  UNLINK
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={action === channel}
                onClick={() => void link(channel)}
                className="mt-2 px-3 py-1 text-[10px] font-bold tracking-[0.2em] uppercase border border-white/20 text-zinc-300 hover:border-neon-green/50 hover:text-neon-green disabled:opacity-50"
              >
                {action === channel ? "WORKING…" : `LINK ${CHANNEL_LABELS[channel]}`}
              </button>
            )}
          </div>
        ))}
      </div>

      {linkCode && (
        <div className="mt-4 border border-neon-green/40 p-3" role="status">
          <p className="text-[10px] font-mono text-neon-green">CODE: {linkCode.code}</p>
          <p className="mt-1 text-[10px] text-zinc-400">{linkCode.instructions}</p>
        </div>
      )}

      {loading && <p className="mt-4 text-[10px] uppercase text-zinc-500">LOADING PREFERENCES…</p>}
      {error && (
        <p className="mt-4 text-[10px] font-mono text-neon-pink" role="alert">
          {error}
        </p>
      )}
      {actionError && (
        <p className="mt-2 text-[10px] font-mono text-neon-pink" role="alert">
          {actionError}
        </p>
      )}

      {data && (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[540px] border-collapse text-left">
            <thead>
              <tr className="text-[9px] tracking-[0.15em] uppercase text-zinc-500">
                <th className="py-2">EVENT</th>
                {USER_NOTIFICATION_CHANNELS.map((channel) => (
                  <th key={channel} className="py-2 text-center">
                    {CHANNEL_LABELS[channel]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {NOTIFICATION_EVENTS.map((event) => (
                <tr key={event} className="border-t border-white/5">
                  <td className="py-2 text-[10px] text-zinc-300">{EVENT_LABELS[event]}</td>
                  {USER_NOTIFICATION_CHANNELS.map((channel) => {
                    const id = `${event}:${channel}`;
                    return (
                      <td key={channel} className="py-2 text-center">
                        <input
                          type="checkbox"
                          aria-label={`${EVENT_LABELS[event]} via ${CHANNEL_LABELS[channel]}`}
                          checked={effective(event, channel)}
                          disabled={action === id}
                          onChange={(e) => void toggle(event, channel, e.target.checked)}
                          className="accent-neon-green"
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
