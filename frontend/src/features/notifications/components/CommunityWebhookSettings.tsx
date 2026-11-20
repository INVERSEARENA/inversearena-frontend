"use client";

import { useState } from "react";
import { useCommunityWebhooks } from "../hooks/useCommunityWebhooks";

/** Host setup for community announcement webhooks (#1735). */
export function CommunityWebhookSettings({ arenaId }: { arenaId: string }) {
  const { webhooks, loading, error, addWebhook, removeWebhook, announce } =
    useCommunityWebhooks(arenaId);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await task();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Webhook request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Community webhooks" className="border border-white/10 p-4">
      <h3 className="text-xs font-bold tracking-[0.2em] uppercase text-zinc-300">
        COMMUNITY WEBHOOKS
      </h3>
      <p className="mt-2 text-[10px] text-zinc-500">
        Announce this arena in your Discord or Telegram community channel.
      </p>

      <form
        className="mt-4 grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await addWebhook(url, name || undefined);
            setUrl("");
            setName("");
          });
        }}
      >
        <input
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://discord.com/api/webhooks/…"
          aria-label="Webhook URL"
          className="border border-white/10 bg-transparent px-3 py-2 text-xs text-zinc-200"
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Label (optional)"
          aria-label="Webhook label"
          className="border border-white/10 bg-transparent px-3 py-2 text-xs text-zinc-200"
        />
        <button
          type="submit"
          disabled={busy || !url}
          className="px-4 py-2 text-[10px] font-bold tracking-[0.2em] uppercase border border-neon-green/50 text-neon-green hover:bg-neon-green/10 disabled:opacity-50"
        >
          ADD WEBHOOK
        </button>
      </form>

      <ul className="mt-4 space-y-2">
        {webhooks.map((webhook) => (
          <li key={webhook.id} className="flex items-center justify-between text-[10px] text-zinc-400">
            <span>
              {webhook.name ?? "Webhook"} — <span className="font-mono">{webhook.urlMasked}</span>
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => removeWebhook(webhook.id))}
              className="uppercase text-neon-pink disabled:opacity-50"
            >
              REMOVE
            </button>
          </li>
        ))}
      </ul>

      <button
        type="button"
        disabled={busy || webhooks.length === 0}
        onClick={() =>
          void run(async () => {
            const result = await announce();
            setStatus(
              `Announcement queued: ${result.delivered} delivered, ${result.retrying} retrying, ${result.failed} failed.`,
            );
          })
        }
        className="mt-4 px-4 py-2 text-[10px] font-bold tracking-[0.2em] uppercase border border-white/20 text-zinc-300 hover:border-neon-green/50 disabled:opacity-50"
      >
        ANNOUNCE ARENA
      </button>

      {loading && <p className="mt-2 text-[10px] uppercase text-zinc-500">LOADING…</p>}
      {error && <p className="mt-2 text-[10px] text-neon-pink">{error}</p>}
      {actionError && <p className="mt-2 text-[10px] text-neon-pink">{actionError}</p>}
      {status && <p className="mt-2 text-[10px] text-neon-green">{status}</p>}
    </section>
  );
}
