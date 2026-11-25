import type { Command } from "commander";
import type { Context } from "../context.js";
import { ArgumentError } from "../encode.js";
import { CONTRACT_KINDS, type ContractKind, isContractId } from "../manifest.js";
import { WASM_FILES, type WasmKind } from "../ops.js";
import { print } from "../output.js";
import { resolveArena } from "./arena.js";

/**
 * Any contract method, with arguments encoded from the contract spec.
 * Always simulated; sent only with --submit.
 */
export function registerInvoke(program: Command, context: () => Context) {
  program
    .command("invoke <contract> <method> [args...]")
    .description(
      "Call any method. <contract> is a kind (factory, oracle, vault, staking, payout), arena:<id>, or a C... id with --kind",
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
        contractId = ctx.contract(target as ContractKind);
        kind = target as WasmKind;
      } else if (isContractId(target)) {
        if (!(opts.kind in WASM_FILES)) throw new ArgumentError(`--kind must be one of ${Object.keys(WASM_FILES).join(", ")}`);
        contractId = target;
        kind = opts.kind as WasmKind;
      } else {
        throw new ArgumentError(`Unknown contract "${target}"`);
      }
      print(await ctx.ops.mutate(contractId, kind, method, args), ctx.json);
    });
}
