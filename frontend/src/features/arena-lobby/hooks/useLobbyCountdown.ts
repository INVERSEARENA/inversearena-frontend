"use client";

/**
 * useLobbyCountdown — live countdown to the lobby's join deadline (#1604).
 *
 * Returns a formatted countdown string that updates every second while the
 * deadline is in the future.  Extracted so it can be tested with a fake clock
 * and so `PlayerRoster` / `LobbyHeader` can consume it independently.
 */

import { useEffect, useState } from "react";

function formatCountdown(joinDeadline: string | null): string {
  if (!joinDeadline) return "No deadline";
  const remaining = Math.max(0, Date.parse(joinDeadline) - Date.now());
  const totalSeconds = Math.floor(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export function useLobbyCountdown(joinDeadline: string | null): string {
  const [display, setDisplay] = useState(() => formatCountdown(joinDeadline));

  useEffect(() => {
    setDisplay(formatCountdown(joinDeadline));
    if (!joinDeadline) return;

    const remaining = Date.parse(joinDeadline) - Date.now();
    if (remaining <= 0) return;

    const id = window.setInterval(() => {
      const next = formatCountdown(joinDeadline);
      setDisplay(next);
      if (next === "0m 0s") window.clearInterval(id);
    }, 1_000);

    return () => window.clearInterval(id);
  }, [joinDeadline]);

  return display;
}
