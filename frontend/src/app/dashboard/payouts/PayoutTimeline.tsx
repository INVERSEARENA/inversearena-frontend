"use client";

import { useEffect, useState } from "react";

type TimelineItem = {
  id: string;
  status: string;
  txHash?: string | null;
  replacesTransactionId?: string | null;
  createdAt: string;
};

export function PayoutTimeline({ transactionId }: { transactionId: string }) {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const startedAt = Date.now();
    fetch(`/api/transactions/${encodeURIComponent(transactionId)}/timeline`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Timeline request failed: ${response.status}`);
        return response.json() as Promise<{ timeline: TimelineItem[] }>;
      })
      .then((result) => {
        setItems(result.timeline);
        console.info("payout_timeline_loaded", { transactionId, latencyMs: Date.now() - startedAt });
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError") setFailed(true);
      });
    return () => controller.abort();
  }, [transactionId]);

  if (failed) return <p className="font-mono text-xs text-red-400">Payout timeline unavailable.</p>;
  return (
    <section className="border border-white/10 bg-black/30 p-4" aria-label="Payout lifecycle">
      <h2 className="mb-3 font-mono text-sm uppercase text-neon-green">Payout lifecycle</h2>
      <ol className="space-y-3">
        {items.map((item, index) => (
          <li key={item.id} className="border-l-2 border-neon-green pl-3 font-mono text-xs text-white/70">
            <span className="text-white">{item.status.toUpperCase()}</span>
            {item.replacesTransactionId && <span className="ml-2 text-amber-300">replacement #{index + 1}</span>}
            <div>{new Date(item.createdAt).toLocaleString()}</div>
            {item.txHash && <div className="truncate text-white/40">{item.txHash}</div>}
          </li>
        ))}
      </ol>
    </section>
  );
}
