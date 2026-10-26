import type { Command } from "commander";
import type { Context } from "../context.js";
import { ArgumentError } from "../encode.js";
import { print } from "../output.js";
import { paged } from "../reads.js";

/** Factory page size cap (MAX_ARENAS_PAGE_SIZE in factory/src/types.rs). */
export const ARENAS_PAGE_SIZE = 50;

export async function listPools(ctx: Context, opts: { host?: string | undefined; maxPages: number }): Promise<unknown[]> {
  const factory = ctx.contract("factory");
  if (opts.host !== undefined) {
    return paged(
      async (page) => (await ctx.ops.read(factory, "factory", "get_arenas_by_host", [opts.host!, String(page)])) as unknown[],
      ARENAS_PAGE_SIZE,
      opts.maxPages,
    );
  }
  return paged(
    async (page) =>
      (await ctx.ops.read(factory, "factory", "get_arenas", [String(page * ARENAS_PAGE_SIZE), String(ARENAS_PAGE_SIZE)])) as unknown[],
    ARENAS_PAGE_SIZE,
    opts.maxPages,
  );
}

export function registerFactory(program: Command, context: () => Context) {
  const factory = program.command("factory").description("Factory-level views");

  factory
    .command("pools")
    .description("Arenas created by the factory, optionally for one host")
    .option("--host <address>", "only this host's pools (G...)")
    .option("--max-pages <n>", `pages of ${ARENAS_PAGE_SIZE} to read`, "20")
    .action(async (opts: { host?: string; maxPages: string }) => {
      const ctx = context();
      const maxPages = Number(opts.maxPages);
      if (!Number.isInteger(maxPages) || maxPages < 1) throw new ArgumentError("--max-pages must be a positive integer");
      const pools = await listPools(ctx, { host: opts.host, maxPages });
      print(ctx.json ? { factory: ctx.contract("factory"), host: opts.host ?? null, count: pools.length, pools } : pools, ctx.json);
    });
}
