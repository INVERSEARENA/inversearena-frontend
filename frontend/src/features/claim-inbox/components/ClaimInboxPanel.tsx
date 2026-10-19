/**
 * Claim and refund inbox panel (#1489).
 *
 * The one place a wallet can see everything it has money waiting on: claimable
 * winnings, refundable stakes, submissions in flight, settled history, and —
 * importantly — positions whose state could not be determined.
 *
 * ## Why `unavailable` gets its own rendering
 *
 * A failed chain read is not "nothing to do". Rendering it as an empty state
 * would tell a user with a real payout that there is nothing to claim, and they
 * would find out about it when the money was gone. So it renders as an explicit
 * unknown with a retry, and the panel discloses when the scan was incomplete.
 *
 * @module
 */

"use client";

import { useCallback, useState } from "react";

import { stroopsToAmount } from "@/shared-d/utils/stellar-asset-reader";

import { useClaimInbox } from "../useClaimInbox";
import type { ClaimInboxItem, ClaimInboxState } from "../types";

/** Tailwind classes per state. Kept as a lookup so a new state cannot slip in unstyled. */
const STATE_STYLES: Record<ClaimInboxState, { label: string; text: string; border: string }> = {
  actionable: { label: "ACTIONABLE", text: "text-neon-green", border: "border-neon-green/40" },
  pending: { label: "PENDING", text: "text-amber-400", border: "border-amber-400/40" },
  completed: { label: "COMPLETED", text: "text-zinc-500", border: "border-zinc-700" },
  blocked: { label: "BLOCKED", text: "text-neon-pink", border: "border-neon-pink/40" },
  unavailable: { label: "UNAVAILABLE", text: "text-orange-400", border: "border-orange-400/40" },
};

/**
 * Render a stroop balance.
 *
 * `bigint` throughout: these are balances, and a pot above 2^53 stroops is
 * representable as a string and silently wrong as a `Number`. The contract pins
 * every asset to 7 decimals, which is what `stroopsToAmount` assumes.
 */
function formatStroops(amountStroops: string): string {
  return stroopsToAmount(BigInt(amountStroops));
}

function shortAge(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function ClaimInboxRow({
  item,
  reconciling,
  onRetry,
  onAction,
}: {
  item: ClaimInboxItem;
  reconciling: boolean;
  onRetry: (arenaId: string) => void;
  onAction: (item: ClaimInboxItem) => void;
}) {
  const style = STATE_STYLES[item.state];
  const age = shortAge(item.freshness.recordAgeSeconds);

  return (
    <li className={`border-l-2 ${style.border} pl-3 py-2`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm text-zinc-200">{item.arenaName ?? item.arenaId}</span>
        {/*
          The server's verdict always renders, even while reconciling. Replacing
          it with a "syncing" label would hide the one thing the user needs to
          see; the pending state is disclosed separately below.
        */}
        <span className={`shrink-0 text-xs font-bold tracking-wider ${style.text}`}>
          {style.label}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-400">
        {item.totalsByAsset.map((total) => (
          <span key={`${total.code}:${total.issuer ?? "native"}`}>
            {formatStroops(total.amountStroops)} {total.code}
            {total.issuer ? null : " (native)"}
          </span>
        ))}
      </div>

      {/*
        Server-authored, and built without a wallet address, so it is safe to
        render verbatim. The app has no i18n layer.
      */}
      <p className="mt-1 text-xs text-zinc-500">{item.message}</p>

      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-600">
        {age ? <span>records {age}</span> : null}
        {item.freshness.stale ? <span className="text-orange-400">stale</span> : null}
        {reconciling ? <span className="text-amber-400">awaiting chain confirmation</span> : null}
      </div>

      {item.action && !reconciling ? (
        <button
          type="button"
          onClick={() => (item.action?.type === "retry" ? onRetry(item.arenaId) : onAction(item))}
          className="mt-2 border border-zinc-700 px-2 py-1 text-xs tracking-wider text-zinc-300 hover:border-zinc-500"
        >
          {item.action.label}
        </button>
      ) : null}
    </li>
  );
}

export function ClaimInboxPanel() {
  const {
    items,
    summary,
    loading,
    loadingMore,
    error,
    hasMore,
    verificationComplete,
    reconciling,
    refresh,
    loadMore,
    markSubmitted,
  } = useClaimInbox();

  const [lastAction, setLastAction] = useState<string | null>(null);

  const handleRetry = useCallback(
    (arenaId: string) => {
      setLastAction(null);
      void markSubmitted(arenaId);
    },
    [markSubmitted],
  );

  /**
   * Hand the action off to the caller.
   *
   * The inbox aggregates and does not move funds: the actual claim and refund
   * flows live elsewhere, so this only records the intent and asks for a
   * re-read. `markSubmitted` is what a successful submission calls, and it
   * deliberately re-reads instead of patching the row to `completed`.
   */
  const handleAction = useCallback(
    (item: ClaimInboxItem) => {
      setLastAction(`${item.arenaName ?? item.arenaId}: ${item.action?.label ?? "action"}`);
      void refresh();
    },
    [refresh],
  );

  return (
    <section
      aria-label="Claim inbox"
      className="border-3 border-[#1c2739] bg-black/40 p-5 font-mono md:col-span-2 lg:col-span-3"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-bold tracking-widest text-zinc-300">CLAIM INBOX</h2>
        <div className="flex items-center gap-3 text-xs">
          {summary ? (
            <span className="text-zinc-500">
              <span className="text-neon-green">{summary.actionable}</span> actionable
              {summary.unavailable > 0 ? (
                <>
                  {" · "}
                  <span className="text-orange-400">{summary.unavailable}</span> unavailable
                </>
              ) : null}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="tracking-wider text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
          >
            {loading ? "…" : "REFRESH"}
          </button>
        </div>
      </div>

      {/*
        Disclosed rather than implied: a partial scan means some rows are
        decided by records alone, and the user is entitled to know that before
        acting on them.
      */}
      {!verificationComplete && !loading && !error ? (
        <p className="mt-2 border border-orange-400/40 px-2 py-1 text-xs text-orange-400">
          Some positions could not be verified against the chain. They are shown as unavailable
          rather than guessed — retry to try again.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 border border-neon-pink/40 px-2 py-1 text-xs text-neon-pink">
          {error}
        </p>
      ) : null}

      {lastAction ? (
        <p className="mt-2 text-xs text-zinc-500">{lastAction}</p>
      ) : null}

      {loading && items.length === 0 ? (
        <p className="mt-4 text-xs text-zinc-500">Loading…</p>
      ) : null}

      {!loading && !error && items.length === 0 ? (
        <p className="mt-4 text-xs text-zinc-500">
          Nothing waiting on you. Winnings and refundable stakes appear here as soon as they exist.
        </p>
      ) : null}

      {items.length > 0 ? (
        <ul className="mt-4 space-y-3">
          {items.map((item) => (
            <ClaimInboxRow
              key={item.arenaId}
              item={item}
              reconciling={reconciling.has(item.arenaId)}
              onRetry={handleRetry}
              onAction={handleAction}
            />
          ))}
        </ul>
      ) : null}

      {hasMore ? (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className="mt-4 text-xs tracking-wider text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
        >
          {loadingMore ? "LOADING…" : "LOAD MORE"}
        </button>
      ) : null}
    </section>
  );
}
