import type { Command } from "commander";
import type { Context } from "../context.js";
import { ArgumentError } from "../encode.js";
import { CONTRACT_KINDS, isContractId } from "../manifest.js";
import { WASM_FILES, type WasmKind } from "../ops.js";
import { print } from "../output.js";
import { resolveArena } from "./arena.js";

export function registerRestore(program: Command, context: () => Context) {
  const restore = program.command("restore").description("Recover archived Soroban contract state");

  restore
    .command("archived <contract> <method> [args...]")
    .description(
      "Simulate a call, report archived footprint entries, and submit RestoreFootprint with --submit. <contract> is a kind, arena:<id>, or a C... id with --kind",
    )
    .option("--kind <kind>", `spec to use for a raw C... id with --wasm-dir (${Object.keys(WASM_FILES).join(", ")})`, "arena")
    .action(async (target: string, method: string, args: string[], opts: { kind: string }) => {
      const ctx = context();
      let contractId: string;
      let kind: WasmKind;
      if (target.startsWith("arena:")) {
        contractId = await resolveArena(ctx, target.slice("arena:".length));
        kind = "arena";
      } else if (target in CONTRACT_KINDS) {
        contractId = ctx.contract(target as keyof typeof CONTRACT_KINDS);
        kind = target as WasmKind;
      } else if (isContractId(target)) {
        if (!(opts.kind in WASM_FILES)) throw new ArgumentError(`--kind must be one of ${Object.keys(WASM_FILES).join(", ")}`);
        contractId = target;
        kind = opts.kind as WasmKind;
      } else {
        throw new ArgumentError(`Unknown contract "${target}"`);
      }
      print(await ctx.ops.restoreArchived(contractId, kind, method, args), ctx.json);
    });
}
