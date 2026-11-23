"use client";

import { useEffect, useState } from "react";

interface ReservesStatusProps {
  arenaId: string | null;
}

interface Reserves {
  tokenBalance: number;
  principalLiabilities: number;
  yieldLiabilities: number;
  coverageBps: number;
}

export function ReservesStatus({ arenaId }: ReservesStatusProps) {
  const [reserves, setReserves] = useState<Reserves | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    if (!arenaId) {
      setState("unavailable");
      return;
    }

    let active = true;
    fetch("/api/arenas/" + encodeURIComponent(arenaId) + "/reserves")
      .then((response) => {
        if (!response.ok) throw new Error("reserves unavailable");
        return response.json() as Promise<Reserves>;
      })
      .then((value) => {
        if (active) {
          setReserves(value);
          setState("ready");
        }
      })
      .catch(() => {
        if (active) setState("unavailable");
      });

    return () => {
      active = false;
    };
  }, [arenaId]);

  return (
    <section className="border-2 border-black bg-white px-4 py-3 md:px-6" aria-live="polite">
      <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-black">
        PROOF OF RESERVES
      </p>
      {state === "ready" && reserves ? (
        <div className="mt-2 grid grid-cols-2 gap-3 font-mono text-xs text-black md:grid-cols-4">
          <span>HOLDINGS {reserves.tokenBalance}</span>
          <span>PRINCIPAL {reserves.principalLiabilities}</span>
          <span>YIELD {reserves.yieldLiabilities}</span>
          <span>COVERAGE {reserves.coverageBps} BPS</span>
        </div>
      ) : (
        <p className="mt-2 font-mono text-xs text-zinc-600">
          {state === "loading" ? "Checking verified vault reserves &" : "Reserve data unavailable"}
        </p>
      )}
    </section>
  );
}
