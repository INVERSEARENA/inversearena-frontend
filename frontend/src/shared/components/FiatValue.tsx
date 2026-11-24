"use client";

import React from "react";

interface FiatValueProps {
  usd: number | null;
  stale?: boolean;
  locale?: string;
}

/**
 * Renders a fiat equivalent value (#1858).
 * Always secondary: labelled with "≈" and suppressed entirely when stale.
 */
export function FiatValue({ usd, stale = false, locale = "en" }: FiatValueProps) {
  if (stale || usd === null || usd === undefined) return null;

  const formatted = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(usd);

  return (
    <span className="text-xs text-gray-500 dark:text-gray-400">
      ≈ {formatted}
    </span>
  );
}
