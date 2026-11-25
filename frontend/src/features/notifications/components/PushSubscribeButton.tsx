"use client";

import { usePushSubscription } from "../hooks/usePushSubscription";

interface PushSubscribeButtonProps {
  className?: string;
}

// ── Opt-in toggle for Web Push round-phase alerts (#1571) ──────────
// Subscribes this device via the service worker + VAPID key, then stores the
// subscription (bound to the wallet) in the backend. Delivery honors the
// user's notification preferences and stops on unsubscribe.
export function PushSubscribeButton({ className = "" }: PushSubscribeButtonProps) {
  const { supported, permission, subscribed, loading, error, subscribe, unsubscribe } =
    usePushSubscription();

  if (!supported) {
    return null;
  }

  const busy = loading;
  const label = subscribed
    ? "PUSH_ALERTS: ON"
    : permission === "denied"
      ? "PUSH BLOCKED IN BROWSER"
      : "ENABLE PUSH ALERTS";

  return (
    <div className={className}>
      <button
        type="button"
        disabled={busy || (!subscribed && permission === "denied")}
        onClick={() => void (subscribed ? unsubscribe() : subscribe())}
        aria-pressed={subscribed}
        title={
          subscribed
            ? "Disable round-phase push alerts on this device"
            : "Get round, reveal, and payout alerts even with the app closed"
        }
        className="px-4 py-2 text-[10px] font-bold tracking-[0.2em] uppercase border border-neon-green/50 text-neon-green hover:bg-neon-green/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy ? "WORKING…" : label}
      </button>
      {error && (
        <p className="mt-2 text-[10px] font-mono text-neon-pink" role="alert">
          {error}
        </p>
      )}
      {permission === "denied" && !subscribed && (
        <p className="mt-2 text-[10px] font-mono text-zinc-500 uppercase">
          Re-enable notifications in your browser site settings to opt in.
        </p>
      )}
    </div>
  );
}
