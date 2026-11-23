/**
 * Seed arenas in every lifecycle state for local development (#1647).
 *
 * Creates funded test accounts and four arenas — open, active (in-progress),
 * finished, and cancelled — so a fresh `make dev` stack has something to click
 * through immediately.
 *
 * Usage (from repo root, after `make dev` has brought the stack up):
 *   npx tsx scripts/seed-arenas.ts
 *   npx tsx scripts/seed-arenas.ts --reset
 *
 * Reads DATABASE_URL (or falls back to the docker-compose dev default).
 * Writes a summary to `scripts/.seed-state.json` so `make dev-reset` can clean
 * up after itself.
 */

import * as fs from "fs";
import * as path from "path";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://testuser:testpassword@localhost:5432/inversearena";

const STATE_FILE = path.resolve(__dirname, ".seed-state.json");

const TEST_ACCOUNTS = [
  { label: "admin", index: 0 },
  { label: "payout-source", index: 1 },
  { label: "player-1", index: 2 },
  { label: "player-2", index: 3 },
  { label: "player-3", index: 4 },
  { label: "player-4", index: 5 },
] as const;

type ArenaState = "Open" | "InProgress" | "Finished" | "Cancelled";

const SEED_ARENAS: Array<{
  key: string;
  state: ArenaState;
  metadata: Record<string, unknown>;
}> = [
  {
    key: "seed-open",
    state: "Open",
    metadata: {
      label: "Open arena — waiting for players",
      entryFee: 500,
      maxPlayers: 10,
      playerCount: 3,
      roundNumber: 1,
    },
  },
  {
    key: "seed-active",
    state: "InProgress",
    metadata: {
      label: "Active arena — round in commit phase",
      entryFee: 500,
      maxPlayers: 10,
      playerCount: 8,
      roundNumber: 3,
    },
  },
  {
    key: "seed-finished",
    state: "Finished",
    metadata: {
      label: "Finished arena — minority side won",
      entryFee: 500,
      maxPlayers: 10,
      playerCount: 10,
      roundNumber: 6,
      winner: "player-1",
    },
  },
  {
    key: "seed-cancelled",
    state: "Cancelled",
    metadata: {
      label: "Cancelled arena — never reached quorum",
      entryFee: 500,
      maxPlayers: 10,
      playerCount: 2,
      roundNumber: 1,
      cancelReason: "quorum-not-reached",
    },
  },
];

function log(msg: string) {
  console.log(`[seed] ${msg}`);
}

/**
 * Minimal Postgres client via `pg` (already a backend dependency). Avoids
 * requiring the full Prisma client for a dev-time seed.
 */
async function getPool() {
  try {
    const { Pool } = await import("pg");
    return new Pool({ connectionString: DATABASE_URL });
  } catch (err) {
    console.error(
      "[seed] Failed to load `pg`. Run `npm install` in backend/ first.",
    );
    throw err;
  }
}

async function main() {
  const reset = process.argv.includes("--reset");
  const pool = await getPool();

  if (reset) {
    log("resetting previously seeded arenas…");
    for (const arena of SEED_ARENAS) {
      await pool.query(`DELETE FROM arenas WHERE metadata->>'seedKey' = $1`, [
        arena.key,
      ]);
    }
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
    log("reset complete");
    await pool.end();
    return;
  }

  log(`connecting to ${DATABASE_URL.replace(/:[^:@]+@/, ":***@")}`);
  const seeded: Array<{ key: string; state: ArenaState; id: string }> = [];

  for (const arena of SEED_ARENAS) {
    const metadata = { ...arena.metadata, seedKey: arena.key, state: arena.state };
    const result = await pool.query(
      `INSERT INTO arenas (id, metadata, created_at, updated_at)
       VALUES (gen_random_uuid(), $1::jsonb, NOW(), NOW())
       RETURNING id`,
      [JSON.stringify(metadata)],
    );
    const id = result.rows[0].id;
    seeded.push({ key: arena.key, state: arena.state, id });
    log(`seeded ${arena.state.padEnd(10)} arena ${id} (${arena.metadata.label})`);
  }

  const state = {
    seededAt: new Date().toISOString(),
    databaseUrl: DATABASE_URL,
    accounts: TEST_ACCOUNTS.map((a) => ({ label: a.label, index: a.index })),
    arenas: seeded,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  log(`wrote ${STATE_FILE}`);
  log(`done — ${seeded.length} arenas across 4 states`);
  await pool.end();
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
