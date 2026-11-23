"use client";

import { QuorumProgress } from "@/components/arena-v2/waiting/QuorumProgress";
import { EntryStatsCards } from "@/components/arena-v2/waiting/EntryStatsCards";

/**
 * Arena overlay gallery (#1645) — waiting-state overlays shown while an arena
 * fills quorum.
 */
export default function ArenaOverlaysGallery() {
  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 text-lg font-semibold">QuorumProgress</h2>
        <QuorumProgress
          arenaId={842}
          currentPlayers={72}
          requiredPlayers={100}
          estimatedStart="04:12:09"
          blockHeight="49,210,123"
        />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">QuorumProgress — just filled</h2>
        <QuorumProgress currentPlayers={100} requiredPlayers={100} estimatedStart="00:00:03" />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">EntryStatsCards</h2>
        <EntryStatsCards entryStake="500 XLM" prizePool="50,000 XLM" rwaLiveYield="+2.453 XLM" />
      </section>
    </div>
  );
}
