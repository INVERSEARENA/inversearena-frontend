import { createHash } from "crypto";
import type { ArenaService } from "../services/arenaService";
import { cache, cacheKeys, cacheTTL } from "./cacheService";

export type ArenaSnapshot = Awaited<ReturnType<ArenaService["getSnapshot"]>>;

/**
 * Semantic snapshot versioning (#1500).
 *
 * Every verified arena snapshot is reduced to a canonical payload that
 * contains every user-visible state field and excludes volatile transport
 * fields (timestamps, connection metadata, ledger read times). The canonical
 * payload is hashed into a fingerprint; the fingerprint plus the canonical
 * payload itself are persisted as the snapshot's version metadata.
 *
 * Equality decisions compare BOTH the fingerprint and the canonical payload,
 * so even a hash collision (the "hash collision fixture" in the tests) can
 * never suppress a real state change: the canonical payload is authoritative.
 *
 * Version metadata is monotonic per arena:
 *  - `version` increments by exactly 1 on every semantic change;
 *  - `previousVersion` references the version this snapshot replaced
 *    (null for the first snapshot after a cold start with no prior meta);
 *  - versions resume from the persisted metadata across process restarts and
 *    from the in-process copy across cache eviction.
 */
export interface ArenaSnapshotMeta {
  arenaId: string;
  version: number;
  previousVersion: number | null;
  /** Hex SHA-256 of {@link ArenaSnapshotMeta.canonical}. */
  fingerprint: string;
  /** Canonical serialization of the user-visible snapshot state. */
  canonical: string;
  /** ISO time the full snapshot was last rewritten. */
  persistedAt: string;
  /** ISO time the poller last verified liveness (refreshed on unchanged polls). */
  heartbeatAt: string;
}

export type ArenaPollStages = {
  fetch: () => Promise<ArenaSnapshot>;
  verify: (snapshot: ArenaSnapshot) => ArenaSnapshot;
  load: () => Promise<ArenaSnapshotMeta | null>;
  persist: (snapshot: ArenaSnapshot, meta: ArenaSnapshotMeta) => Promise<void>;
  heartbeat: (meta: ArenaSnapshotMeta) => Promise<void>;
  publish: (snapshot: ArenaSnapshot, meta: ArenaSnapshotMeta) => Promise<void>;
};

export type ArenaPollOutcome =
  | { kind: "published"; snapshot: ArenaSnapshot; meta: ArenaSnapshotMeta }
  | { kind: "suppressed"; snapshot: ArenaSnapshot; meta: ArenaSnapshotMeta };

export function verifyArenaSnapshot(arenaId: string, snapshot: ArenaSnapshot): ArenaSnapshot {
  if (snapshot.arenaId !== arenaId || !Number.isFinite(snapshot.currentRound)) {
    throw new Error("Arena snapshot failed identity validation");
  }
  return snapshot;
}

/** Deterministic JSON: object keys sorted at every depth, arrays order-preserving. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

/**
 * Canonical serialization of the user-visible snapshot state.
 *
 * Includes every field a spectator can see (identity, round, counts, status,
 * elimination feed, round state) and excludes volatile transport fields.
 * `recentEliminations` is sorted by id so feed ordering churn alone is not a
 * semantic change.
 */
export function canonicalizeArenaSnapshot(snapshot: ArenaSnapshot): string {
  const recentEliminations = [...snapshot.recentEliminations]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((entry) => ({
      id: entry.id,
      userId: entry.userId,
      roundNumber: entry.roundNumber,
      reason: entry.reason,
      eliminatedAt: entry.eliminatedAt,
    }));

  return stableStringify({
    arenaId: snapshot.arenaId,
    currentRound: snapshot.currentRound,
    playerCount: snapshot.playerCount,
    survivorCount: snapshot.survivorCount,
    status: snapshot.status,
    lastRoundState: snapshot.lastRoundState,
    recentEliminations,
  });
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Canonical fingerprint of a snapshot: hash of its canonical serialization. */
export function fingerprintArenaSnapshot(
  snapshot: ArenaSnapshot,
  hash: (input: string) => string = sha256Hex,
): { fingerprint: string; canonical: string } {
  const canonical = canonicalizeArenaSnapshot(snapshot);
  return { fingerprint: hash(canonical), canonical };
}

export interface ArenaPollStageOverrides {
  fetch?: () => Promise<ArenaSnapshot>;
  load?: () => Promise<ArenaSnapshotMeta | null>;
  persist?: (snapshot: ArenaSnapshot, meta: ArenaSnapshotMeta) => Promise<void>;
  heartbeat?: (meta: ArenaSnapshotMeta) => Promise<void>;
}

export function createArenaPollStages(
  arenaId: string,
  arenaService: ArenaService,
  publish: (snapshot: ArenaSnapshot, meta: ArenaSnapshotMeta) => Promise<void> = async () => undefined,
  overrides: ArenaPollStageOverrides = {},
): ArenaPollStages {
  return {
    fetch: overrides.fetch ?? (() => arenaService.getSnapshot(arenaId)),
    verify: (snapshot) => verifyArenaSnapshot(arenaId, snapshot),
    load:
      overrides.load ??
      (async () => cache.get<ArenaSnapshotMeta>(cacheKeys.arenaSnapshotMeta(arenaId))),
    persist:
      overrides.persist ??
      (async (snapshot, meta) => {
        // Generation-guarded writes: a stale writer racing a newer version can
        // never roll the persisted state backwards (#1500 ordering races).
        await Promise.all([
          cache.setIfGenerationIsNewer(
            cacheKeys.arenaVerifiedSnapshot(arenaId),
            { snapshot, meta },
            meta.version,
            cacheTTL.ARENA_ONCHAIN_SNAPSHOT,
          ),
          cache.setIfGenerationIsNewer(
            cacheKeys.arenaSnapshotMeta(arenaId),
            meta,
            meta.version,
            cacheTTL.ARENA_ONCHAIN_SNAPSHOT,
          ),
        ]);
      }),
    heartbeat:
      overrides.heartbeat ??
      (async (meta) => {
        // Small metadata write only — never rewrites the full snapshot and
        // never consumes a publication.
        await cache.set(
          cacheKeys.arenaSnapshotMeta(arenaId),
          meta,
          cacheTTL.ARENA_ONCHAIN_SNAPSHOT,
        );
      }),
    publish,
  };
}

/**
 * fetch → verify → change-detect → persist/publish (or heartbeat-only).
 *
 * Unchanged polls refresh heartbeat metadata and return `suppressed` without
 * rewriting the full snapshot or publishing anything. Changed snapshots get
 * the next monotonic version, a reference to the version they replace, and
 * are persisted then published exactly once.
 */
export async function runArenaPollStages(
  stages: ArenaPollStages,
  hash: (input: string) => string = sha256Hex,
): Promise<ArenaPollOutcome> {
  const fetched = await stages.fetch();
  const verified = stages.verify(fetched);

  const { fingerprint, canonical } = fingerprintArenaSnapshot(verified, hash);
  const previous = await stages.load();
  const now = new Date().toISOString();

  const unchanged =
    previous !== null &&
    previous.fingerprint === fingerprint &&
    previous.canonical === canonical;

  if (unchanged) {
    const meta: ArenaSnapshotMeta = { ...previous, heartbeatAt: now };
    await stages.heartbeat(meta);
    return { kind: "suppressed", snapshot: verified, meta };
  }

  const meta: ArenaSnapshotMeta = {
    arenaId: verified.arenaId,
    version: previous ? previous.version + 1 : 1,
    previousVersion: previous ? previous.version : null,
    fingerprint,
    canonical,
    persistedAt: now,
    heartbeatAt: now,
  };

  await stages.persist(verified, meta);
  await stages.publish(verified, meta);
  return { kind: "published", snapshot: verified, meta };
}
