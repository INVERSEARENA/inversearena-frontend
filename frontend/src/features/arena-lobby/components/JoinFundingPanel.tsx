"use client";

/**
 * Source-asset picker and strict-receive quote review for funded arena joins
 * (#1716). Nothing here signs: it only makes the exact swap parameters visible
 * before `TransactionModal` asks the wallet.
 */

import { formatFeeDisplay } from "@/shared/lib/stellar/stellar-fees";
import {
  isPathQuoteStale,
  type PathQuote,
} from "@/shared/lib/stellar/path-payment-quote";
import type { AssetDescriptor } from "@/shared/lib/stellar/stellar-asset-reader";
import type { JoinFundingMode } from "../hooks/useJoinFlow";

interface JoinFundingPanelProps {
  sourceAssets: readonly AssetDescriptor[];
  selectedSourceCode: string | null;
  onSelectSource: (code: string | null) => void;
  quote: PathQuote | null;
  isQuoting: boolean;
  error: string | null;
  fundingMode: JoinFundingMode;
  preferTwoStep: boolean;
  networkFeeStroops: string;
  onToggleTwoStep: (value: boolean) => void;
  onRetry: () => void;
}

function assetLabel(asset: AssetDescriptor): string {
  return asset.kind === "native"
    ? "XLM"
    : asset.code;
}

function percent(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

export function JoinFundingPanel({
  sourceAssets,
  selectedSourceCode,
  onSelectSource,
  quote,
  isQuoting,
  error,
  fundingMode,
  preferTwoStep,
  networkFeeStroops,
  onToggleTwoStep,
  onRetry,
}: JoinFundingPanelProps) {
  const stale = quote !== null && isPathQuoteStale(quote);

  return (
    <section
      aria-label="Join funding"
      className="mt-4 rounded-2xl border border-white/10 bg-black/30 p-4 text-sm text-white/70"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="flex flex-col gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
            Pay with
          </span>
          <select
            aria-label="Join funding asset"
            value={selectedSourceCode ?? "direct"}
            onChange={(event) =>
              onSelectSource(event.target.value === "direct" ? null : event.target.value)
            }
            className="rounded-lg border border-white/20 bg-[#08101b] px-3 py-2 text-sm text-white"
          >
            <option value="direct">Stake token (no swap)</option>
            {sourceAssets.map((asset) => (
              <option key={`${asset.kind}:${asset.code}`} value={asset.code}>
                {assetLabel(asset)}
              </option>
            ))}
          </select>
        </label>
        {selectedSourceCode !== null && (
          <button
            type="button"
            onClick={onRetry}
            disabled={isQuoting}
            className="rounded-full border border-white/20 px-4 py-2 text-xs font-black uppercase tracking-[0.16em] text-white/70 disabled:opacity-50"
          >
            {isQuoting ? "Quoting..." : "Refresh quote"}
          </button>
        )}
      </div>

      {selectedSourceCode !== null && (
        <label className="mt-3 flex items-center gap-2 text-xs text-white/60">
          <input
            type="checkbox"
            checked={preferTwoStep}
            onChange={(event) => onToggleTwoStep(event.target.checked)}
          />
          Use two signed steps instead of one bundled transaction
        </label>
      )}

      {selectedSourceCode === null ? (
        <p className="mt-3 text-xs text-white/50">
          You will need the arena stake token in your wallet. Pick another asset to fund the
          entry in one signed transaction.
        </p>
      ) : quote ? (
        <div className="mt-4 space-y-2">
          {stale && (
            <p role="alert" className="text-xs font-semibold text-amber-300">
              This quote expired. Refresh it before signing.
            </p>
          )}
          <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            <div className="flex justify-between gap-3">
              <dt className="uppercase tracking-[0.14em] text-white/40">Source amount</dt>
              <dd className="font-mono text-white">
                {quote.sourceAmount} {assetLabel(quote.sourceAsset)}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="uppercase tracking-[0.14em] text-white/40">Receives</dt>
              <dd className="font-mono text-white">
                {quote.destinationAmount} {assetLabel(quote.destinationAsset)}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="uppercase tracking-[0.14em] text-white/40">Path</dt>
              <dd className="font-mono text-white">
                {quote.path.length === 0
                  ? "Direct"
                  : quote.path.map(assetLabel).join(" → ")}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="uppercase tracking-[0.14em] text-white/40">Slippage limit</dt>
              <dd className="font-mono text-white">{percent(quote.slippageBps)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="uppercase tracking-[0.14em] text-white/40">Maximum send</dt>
              <dd className="font-mono text-white">
                {quote.sendMax} {assetLabel(quote.sourceAsset)}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="uppercase tracking-[0.14em] text-white/40">Network fee</dt>
              <dd className="font-mono text-white">
                {formatFeeDisplay(Number(networkFeeStroops) / 10_000_000)}
              </dd>
            </div>
          </dl>
          {fundingMode === "two_step" && (
            <p className="text-xs text-amber-200">
              Bundled signing is unavailable — the swap and join will be tracked as two
              resumable steps.
            </p>
          )}
        </div>
      ) : (
        <p role="status" className="mt-3 text-xs text-white/50">
          {isQuoting
            ? "Quoting a payment path..."
            : error ?? "No payment path is available for this asset."}
        </p>
      )}
      {error && quote && (
        <p role="alert" className="mt-2 text-xs font-semibold text-red-300">
          {error}
        </p>
      )}
    </section>
  );
}
