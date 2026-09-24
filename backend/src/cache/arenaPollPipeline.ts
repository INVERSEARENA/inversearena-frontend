import type { ArenaService } from "../services/arenaService";
import { cache, cacheKeys, cacheTTL } from "./cacheService";

export type ArenaSnapshot = Awaited<ReturnType<ArenaService["getSnapshot"]>>;

export type ArenaPollStages = {
  fetch: () => Promise<ArenaSnapshot>;
  verify: (snapshot: ArenaSnapshot) => ArenaSnapshot;
  persist: (snapshot: ArenaSnapshot) => Promise<void>;
  publish: (snapshot: ArenaSnapshot) => Promise<void>;
};

export function verifyArenaSnapshot(arenaId: string, snapshot: ArenaSnapshot): ArenaSnapshot {
  if (snapshot.arenaId !== arenaId || !Number.isFinite(snapshot.currentRound)) {
    throw new Error("Arena snapshot failed identity validation");
  }
  return snapshot;
}

export function createArenaPollStages(
  arenaId: string,
  arenaService: ArenaService,
  publish: (snapshot: ArenaSnapshot) => Promise<void> = async () => undefined,
): ArenaPollStages {
  return {
    fetch: () => arenaService.getSnapshot(arenaId),
    verify: (snapshot) => verifyArenaSnapshot(arenaId, snapshot),
    persist: async (snapshot) => {
      await cache.set(cacheKeys.arenaOnChainSnapshot(arenaId), snapshot, cacheTTL.ARENA_ONCHAIN_SNAPSHOT);
    },
    publish,
  };
}

export async function runArenaPollStages(stages: ArenaPollStages): Promise<ArenaSnapshot> {
  const fetched = await stages.fetch();
  const verified = stages.verify(fetched);
  await stages.persist(verified);
  await stages.publish(verified);
  return verified;
}