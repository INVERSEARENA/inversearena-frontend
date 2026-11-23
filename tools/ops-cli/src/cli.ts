#!/usr/bin/env node
/**
 * inverse-ops: operator CLI for Inverse Arena contracts (#1648).
 * See tools/ops-cli/README.md.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { registerArena } from "./commands/arena.js";
import { registerFactory } from "./commands/factory.js";
import { registerInvoke } from "./commands/invoke.js";
import { registerOracle } from "./commands/oracle.js";
import { registerVault } from "./commands/vault.js";
import { type Context, type GlobalOptions, createContext } from "./context.js";

export function buildProgram(makeContext: (options: GlobalOptions) => Context = createContext): Command {
  const program = new Command("inverse-ops")
    .description("Inspect Inverse Arena contracts and run lifecycle operations. Mutations are dry runs unless --submit.")
    .option("--manifest <path>", "deployment manifest (default: contract/deployment-manifest.json, or $INVERSE_OPS_MANIFEST)")
    .option("--rpc-url <url>", "override the manifest's RPC URL (or $INVERSE_OPS_RPC_URL)")
    .option("--wasm-dir <dir>", "read contract specs from local WASM builds instead of the network")
    .option("--json", "machine-readable output")
    .option("--signer <spec>", "env:<VAR> | file:<path> | ledger[:<index>]")
    .option("--submit", "send mutating calls instead of simulating them")
    .option("--confirm-mainnet", "allow --submit on mainnet without the interactive prompt")
    .option("--factory <id>", "factory contract id (overrides the manifest)")
    .option("--oracle <id>", "oracle contract id (overrides the manifest)")
    .option("--vault <id>", "RWA vault adapter contract id (overrides the manifest)")
    .option("--staking <id>", "staking contract id (overrides the manifest)")
    .option("--payout <id>", "payout contract id (overrides the manifest)")
    .showHelpAfterError();

  let context: Context | undefined;
  const lazyContext = () => (context ??= makeContext(program.opts<GlobalOptions>()));
  registerArena(program, lazyContext);
  registerFactory(program, lazyContext);
  registerVault(program, lazyContext);
  registerOracle(program, lazyContext);
  registerInvoke(program, lazyContext);
  return program;
}

/** Errors from RPC arrive as plain JSON-RPC objects as well as Error instances. */
export function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  if (error && typeof error === "object" && "message" in error) {
    const { message, code } = error as { message: unknown; code?: unknown };
    return { name: "RpcError", message: code === undefined ? String(message) : `${String(message)} (RPC code ${String(code)})` };
  }
  return { name: "Error", message: String(error) };
}

export async function main(argv: string[]): Promise<number> {
  const program = buildProgram().exitOverride();
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    const json = program.opts<GlobalOptions>().json;
    const { name, message } = describeError(error);
    if (json) process.stdout.write(`${JSON.stringify({ error: { name, message } }, null, 2)}\n`);
    else process.stderr.write(`inverse-ops: ${message}\n`);
    return 1;
  }
}

// Run when executed (including through the npm bin symlink), not when imported by tests.
const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main(process.argv).then((code) => {
    process.exitCode = code;
  });
}
