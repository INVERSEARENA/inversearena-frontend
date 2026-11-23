import type { Command } from "commander";
import type { Context } from "../context.js";
import { decodeArenaEvent, fetchContractEvents, filterRound } from "../events.js";
import { ArgumentError } from "../encode.js";
import { isContractId } from "../manifest.js";
import { print } from "../output.js";
import { paged, readAll } from "../reads.js";

/** An arena by contract id, or by factory pool id. */
export async function resolveArena(ctx: Context, id: string): Promise<string> {
  if (isContractId(id)) return id;
  if (!/^\d+$/.test(id)) throw new ArgumentError(`Arena must be a contract id (C...) or a factory pool id, got "${id}"`);
  const meta = (await ctx.ops.read(ctx.contract("factory"), "factory", "get_arena", [id])) as { arena_address?: string } | undefined;
  if (!meta?.arena_address) throw new ArgumentError(`Factory has no pool ${id}`);
  return meta.arena_address;
}

export async function arenaShow(ctx: Context, id: string) {
  const arena = await resolveArena(ctx, id);
  const read = (method: string, args: string[] = []) => ctx.ops.read(arena, "arena", method, args);
  const views = await readAll({
    version: () => read("version"),
    player_count: () => read("player_count"),
    start_deadline: () => read("get_start_deadline"),
    platform_fee_bps: () => read("get_platform_fee_bps"),
    oracle: () => read("get_oracle_contract"),
    oracle_freshness_policy: () => read("get_oracle_freshness_policy"),
    total_yield: () => read("get_total_yield"),
    leaderboard: () => read("get_leaderboard"),
    players: () => paged(async (page) => (await read("get_players", [String(page)])) as unknown[], 50, 4),
  });
  const rounds: unknown[] = [];
  for (let round = 1; round <= 64; round++) {
    const result = await read("get_round_result", [String(round)]).catch(() => undefined);
    if (result === undefined || result === null) break;
    rounds.push(result);
  }
  return { arena, network: ctx.ops.deployment.network, ...views, rounds };
}

export function registerArena(program: Command, context: () => Context) {
  const arena = program.command("arena").description("Inspect and operate an arena (by contract id or factory pool id)");

  arena
    .command("show <arena>")
    .description("Config, players, leaderboard, yield and round results")
    .action(async (id: string) => {
      const ctx = context();
      print(await arenaShow(ctx, id), ctx.json);
    });

  arena
    .command("events <arena>")
    .description("Decoded contract events, optionally for one round")
    .option("--round <n>", "only events for this round")
    .option("--lookback <ledgers>", "ledgers to search back from the latest", "17280")
    .option("--start-ledger <ledger>", "search from this ledger instead of --lookback")
    .action(async (id: string, opts: { round?: string; lookback: string; startLedger?: string }) => {
      const ctx = context();
      const contractId = await resolveArena(ctx, id);
      const raw = await fetchContractEvents(ctx.ops.server, {
        contractId,
        lookbackLedgers: Number(opts.lookback),
        startLedger: opts.startLedger === undefined ? undefined : Number(opts.startLedger),
      });
      const decoded = raw.map(decodeArenaEvent);
      const events = opts.round === undefined ? decoded : filterRound(decoded, Number(opts.round));
      print(ctx.json ? { arena: contractId, round: opts.round === undefined ? null : Number(opts.round), events } : events, ctx.json);
    });

  arena
    .command("resolve <arena>")
    .description("resolve_round (admin). Dry run unless --submit")
    .action(async (id: string) => {
      const ctx = context();
      print(await ctx.ops.mutate(await resolveArena(ctx, id), "arena", "resolve_round"), ctx.json);
    });
}
