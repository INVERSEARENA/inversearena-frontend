#!/usr/bin/env tsx
/**
 * Idle-arena publication benchmark (#1500).
 *
 * Simulates N polls of an arena whose verified state never changes and
 * compares the pre-#1500 behaviour (persist the full snapshot and publish a
 * full snapshot envelope on every poll) against the semantic gate (persist
 * and publish only on fingerprint change; heartbeat metadata only otherwise).
 *
 * Reports, for an idle arena:
 *   - Redis writes (full snapshot + meta writes vs heartbeat-only meta writes)
 *   - stream bytes written to connected SSE clients
 *   - React store updates on the client (one per applied envelope)
 *
 * Usage:
 *   npm run bench:arena-polling
 *   npm run bench:arena-polling -- --polls 600 --changes 2
 *
 * The benchmark is deterministic and offline: no Redis, no RPC, no HTTP.
 */

import { program } from "commander";
import {
  createArenaPollStages,
  runArenaPollStages,
  type ArenaSnapshot,
  type ArenaSnapshotMeta,
} from "../src/cache/arenaPollPipeline";

interface Counts {
  redisWrites: number;
  streamBytes: number;
  storeUpdates: number;
  publishes: number;
  heartbeats: number;
}

function emptyCounts(): Counts {
  return { redisWrites: 0, streamBytes: 0, storeUpdates: 0, publishes: 0, heartbeats: 0 };
}

function buildSnapshot(): ArenaSnapshot {
  return {
    arenaId: "bench-arena",
    currentRound: 1,
    playerCount: 64,
    survivorCount: 64,
    status: "active",
    recentEliminations: Array.from({ length: 12 }, (_, index) => ({
      id: `elim-${index}`,
      userId: `user-${index}`,
      roundNumber: 1,
      reason: "lost",
      eliminatedAt: "2026-09-01T00:00:00.000Z",
    })),
    lastRoundState: "OPEN",
  } as ArenaSnapshot;
}

function snapshotEnvelope(snapshot: ArenaSnapshot, sequence: number, meta?: Partial<ArenaSnapshotMeta>): string {
  return JSON.stringify({
    type: "snapshot",
    sequence,
    arenaId: snapshot.arenaId,
    payload: snapshot,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...(meta
      ? { version: meta.version, previousVersion: meta.previousVersion, instanceId: "bench-instance" }
      : {}),
  });
}

function percentReduction(before: number, after: number): string {
  if (before === 0) return "n/a";
  return `${(((before - after) / before) * 100).toFixed(1)}%`;
}

function runBaseline(polls: number, snapshot: ArenaSnapshot): Counts {
  const counts = emptyCounts();
  for (let i = 0; i < polls; i += 1) {
    // Pre-#1500: every verified poll rewrote the snapshot and published a
    // full snapshot envelope to every subscriber.
    counts.redisWrites += 2; // snapshot write + meta/state write
    const envelope = snapshotEnvelope(snapshot, i + 1);
    counts.streamBytes += envelope.length;
    counts.storeUpdates += 1;
    counts.publishes += 1;
  }
  return counts;
}

async function runSemanticGate(
  polls: number,
  changeEvery: number,
  snapshot: ArenaSnapshot,
): Promise<Counts> {
  const counts = emptyCounts();
  let sequence = 0;
  let stored: ArenaSnapshotMeta | null = null;
  let current = snapshot;

  for (let i = 0; i < polls; i += 1) {
    if (changeEvery > 0 && i > 0 && i % changeEvery === 0) {
      current = { ...current, survivorCount: current.survivorCount - 1 };
    }

    const stages = createArenaPollStages(
      snapshot.arenaId,
      { getSnapshot: async () => current } as never,
      async (_published, meta) => {
        sequence += 1;
        const envelope = snapshotEnvelope(current, sequence, meta);
        counts.streamBytes += envelope.length;
        counts.storeUpdates += 1;
        counts.publishes += 1;
      },
      {
        load: async () => stored,
        persist: async (_next, meta) => {
          counts.redisWrites += 2; // snapshot write + meta write (generation-guarded)
          stored = meta;
        },
        heartbeat: async (meta) => {
          counts.redisWrites += 1; // metadata only — no snapshot rewrite
          counts.heartbeats += 1;
          stored = meta;
        },
      },
    );

    await runArenaPollStages(stages);
  }

  return counts;
}

async function main(): Promise<void> {
  program
    .option("--polls <n>", "number of simulated polls", "120")
    .option("--changes <n>", "semantic changes during the run (0 = fully idle)", "0")
    .parse(process.argv);

  const polls = Number(program.opts().polls);
  const changes = Number(program.opts().changes);
  if (!Number.isSafeInteger(polls) || polls <= 0) {
    throw new Error("--polls must be a positive integer");
  }
  if (!Number.isSafeInteger(changes) || changes < 0 || changes > polls) {
    throw new Error("--changes must be between 0 and --polls");
  }

  const snapshot = buildSnapshot();
  const changeEvery = changes > 0 ? Math.floor(polls / (changes + 1)) : 0;

  const baseline = runBaseline(polls, snapshot);
  const semantic = await runSemanticGate(polls, changeEvery, snapshot);

  const idleNote = changes === 0 ? "idle arena" : `${changes} semantic change(s)`;
  process.stdout.write(`Arena publication benchmark — ${polls} polls, ${idleNote}\n\n`);
  process.stdout.write(
    `${"metric".padEnd(28)}${"baseline".padStart(14)}${"semantic".padStart(14)}${"reduction".padStart(12)}\n`,
  );
  process.stdout.write(`${"-".repeat(68)}\n`);
  const rows: Array<[string, number, number]> = [
    ["Redis writes", baseline.redisWrites, semantic.redisWrites],
    ["Stream bytes", baseline.streamBytes, semantic.streamBytes],
    ["React store updates", baseline.storeUpdates, semantic.storeUpdates],
    ["Published envelopes", baseline.publishes, semantic.publishes],
  ];
  for (const [label, before, after] of rows) {
    process.stdout.write(
      `${label.padEnd(28)}${String(before).padStart(14)}${String(after).padStart(14)}${percentReduction(before, after).padStart(12)}\n`,
    );
  }
  process.stdout.write(`\nHeartbeat-only metadata refreshes: ${semantic.heartbeats}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
