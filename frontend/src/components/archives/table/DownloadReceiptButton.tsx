"use client";

import { useState } from "react";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

interface DownloadReceiptButtonProps {
  payoutId: string;
  /** Bearer access token for the wallet-owning user; the endpoint 404s without one. */
  accessToken?: string;
}

/**
 * Downloads the settlement receipt CSV for a confirmed payout (#1407).
 *
 * Requires the caller's wallet-signature access token, which the frontend
 * does not yet acquire anywhere (login against POST /api/auth/verify isn't
 * wired into the UI) — this component is the ready-to-use client half of
 * the feature; wiring it to a real accessToken is the same pre-existing gap
 * as every other authenticated frontend call in this app, not something
 * introduced here.
 */
export function DownloadReceiptButton({ payoutId, accessToken }: DownloadReceiptButtonProps) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDownload = async () => {
    setIsDownloading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/payouts/${encodeURIComponent(payoutId)}/receipt.csv`, {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      });
      if (!res.ok) {
        throw new Error(
          res.status === 409 ? "Not settled yet" : res.status === 404 ? "Receipt not found" : "Download failed",
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `receipt-${payoutId}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void handleDownload();
        }}
        disabled={isDownloading}
        className="text-[9px] font-bold uppercase tracking-wider text-[#37FF1C] underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isDownloading ? "..." : "Receipt"}
      </button>
      {error && <span className="text-[8px] text-[#FF3B3B]">{error}</span>}
    </div>
  );
}
