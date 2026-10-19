/**
 * Smoke test against a local network (#1648). Opt-in, because it needs
 * Docker and deployed contracts:
 *
 *   stellar container start local
 *   tools/ops-cli/scripts/local-stack.sh
 *   npm run test:smoke                        # read-only and dry-run checks
 *   INVERSE_OPS_SMOKE_SIGNER=env:OPS_ADMIN_SECRET OPS_ADMIN_SECRET=$(stellar keys secret inverse-ops-admin) npm run test:smoke
 *
 * Runs the built binary exactly as an operator would.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = import.meta.dirname;
const MANIFEST = process.env.INVERSE_OPS_MANIFEST ?? join(HERE, "..", ".local", "manifest.json");
const enabled = process.env.INVERSE_OPS_SMOKE === "1";
const skip = enabled ? false : "set INVERSE_OPS_SMOKE=1 (see the header) to run against a local network";

async function ops(...args: string[]): Promise<any> {
  const { stdout } = await run("node", [join(HERE, "..", "dist", "cli.js"), "--manifest", MANIFEST, "--json", ...args], {
    env: process.env,
  }).catch((error) => ({ stdout: error.stdout as string }));
  return JSON.parse(stdout);
}

const local = () => JSON.parse(readFileSync(MANIFEST, "utf8")).local as { arena: string; host: string };

test("factory pools lists the arena, also filtered by host", { skip }, async () => {
  const all = await ops("factory", "pools");
  assert.ok(all.pools.some((p: any) => p.arena_address === local().arena));
  const byHost = await ops("factory", "pools", "--host", local().host);
  assert.equal(byHost.host, local().host);
  assert.ok(byHost.pools.every((p: any) => p.host === local().host));
});

test("arena show resolves a pool id and reads the arena", { skip }, async () => {
  const shown = await ops("arena", "show", "1");
  assert.equal(shown.arena, local().arena);
  assert.equal(shown.network, "standalone");
  assert.equal(typeof shown.version, "number");
  assert.ok(shown.oracle_freshness_policy.max_age_secs > 0);
});

test("arena events decodes the arena's events", { skip }, async () => {
  const { events } = await ops("arena", "events", local().arena);
  assert.ok(events.some((e: any) => e.event === "initialized" && e.fields.admin === local().host));
});

test("vault reserves reconciles against every factory arena", { skip }, async () => {
  const reserves = await ops("vault", "reserves", "--reconcile");
  assert.ok(reserves.arenas.some((a: any) => a.arena === local().arena));
  assert.equal(typeof reserves.unaccounted, "string");
});

test("oracle schedule reads the rate schedule", { skip }, async () => {
  const schedule = await ops("oracle", "schedule");
  assert.equal(typeof schedule.current_yield_bps, "number");
  assert.ok("schedule" in schedule);
});

test("arena resolve is a dry run and names the contract error", { skip }, async () => {
  const result = await ops("arena", "resolve", "1");
  assert.equal(result.error.name, "ContractCallError");
  assert.match(result.error.message, /RoundNotActive/);
});

test(
  "--submit sends a signed admin call and the change is visible",
  { skip: skip || (process.env.INVERSE_OPS_SMOKE_SIGNER ? false : "set INVERSE_OPS_SMOKE_SIGNER to test submission") },
  async () => {
    const before = (await ops("oracle", "schedule")).current_yield_bps as number;
    const next = before === 600 ? 610 : 600;
    const signer = ["--signer", process.env.INVERSE_OPS_SMOKE_SIGNER!];
    const dry = await ops(...signer, "invoke", "oracle", "set_yield_bps", String(next));
    assert.equal(dry.mode, "dry-run");
    assert.equal((await ops("oracle", "schedule")).current_yield_bps, before, "a dry run changes nothing");

    const sent = await ops(...signer, "--submit", "invoke", "oracle", "set_yield_bps", String(next));
    assert.equal(sent.mode, "submitted");
    assert.match(sent.txHash, /^[0-9a-f]{64}$/);
    assert.equal((await ops("oracle", "schedule")).current_yield_bps, next);
  },
);
