"use client";

/**
 * JoinPanel — round summary and error display panel in the lobby (#1604).
 *
 * A pure presentational component — renders the survivor count, entry fee,
 * and any data-fetch error.  Owns no state.
 */

function formatCurrency(value: number, token: string): string {
  const formatted = value.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${formatted} ${token}`;
}

export interface JoinPanelProps {
  survivorCount: number;
  entryFee: number;
  stakeToken: string;
  error: string | null;
}

export function JoinPanel({
  survivorCount,
  entryFee,
  stakeToken,
  error,
}: JoinPanelProps) {
  return (
    <div className="rounded-[28px] border border-white/10 bg-[#08101b]/95 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.35)] sm:p-6">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/45">
        Round Summary
      </p>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
            Survivors
          </p>
          <p className="mt-2 text-3xl font-black tabular-nums text-[#3CFF1A]">
            {survivorCount}
          </p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
            Entry Fee
          </p>
          <p className="mt-2 text-2xl font-black tabular-nums">
            {formatCurrency(entryFee, stakeToken)}
          </p>
        </div>
      </div>
      {error && (
        <p className="mt-4 rounded-2xl border border-[#FF0A54]/30 bg-[#16070d] px-4 py-3 text-sm text-[#FFB3C4]">
          {error}
        </p>
      )}
    </div>
  );
}
