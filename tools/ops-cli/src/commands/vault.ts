import type { Command } from "commander";
import type { Context } from "../context.js";
import { print } from "../output.js";
import { resolveArena } from "./arena.js";
import { listPools } from "./factory.js";

interface Reserves {
  vault: string;
  total_deposited: string;
  arenas?: Array<{ arena: string; balance: string }>;
  /** total_deposited minus the sum of arena balances; non-zero needs a look. */
  unaccounted?: string;
}

export async function vaultReserves(ctx: Context, opts: { arenas: string[]; reconcile: boolean }): Promise<Reserves> {
  const vault = ctx.contract("vault");
  const total = String(await ctx.ops.read(vault, "vault", "get_total_deposited"));
  const reserves: Reserves = { vault, total_deposited: total };

  let arenas = await Promise.all(opts.arenas.map((id) => resolveArena(ctx, id)));
  if (opts.reconcile) {
    const pools = (await listPools(ctx, { maxPages: 20 })) as Array<{ arena_address: string }>;
    arenas = [...new Set([...arenas, ...pools.map((p) => p.arena_address)])];
  }
  if (arenas.length === 0) return reserves;

  reserves.arenas = await Promise.all(
    arenas.map(async (arena) => ({ arena, balance: String(await ctx.ops.read(vault, "vault", "balance_of", [arena])) })),
  );
  if (opts.reconcile) {
    const held = reserves.arenas.reduce((sum, a) => sum + BigInt(a.balance), 0n);
    reserves.unaccounted = (BigInt(total) - held).toString();
  }
  return reserves;
}

export function registerVault(program: Command, context: () => Context) {
  const vault = program.command("vault").description("RWA vault adapter views");

  vault
    .command("reserves")
    .description("Total deposited, per-arena balances, and reconciliation against the factory's arenas")
    .option("--arena <id...>", "arena(s) to show the balance of (contract or pool id)", [])
    .option("--reconcile", "compare the total with every factory arena's balance", false)
    .action(async (opts: { arena: string[]; reconcile: boolean }) => {
      const ctx = context();
      print(await vaultReserves(ctx, { arenas: opts.arena, reconcile: opts.reconcile }), ctx.json);
    });
}
