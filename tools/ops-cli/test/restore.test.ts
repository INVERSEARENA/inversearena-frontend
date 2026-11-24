import assert from "node:assert/strict";
import { test } from "node:test";
import { buildProgram } from "../src/cli.js";
import type { Context, GlobalOptions } from "../src/context.js";
import { CONTRACT } from "./fixtures.js";

test("restore archived accepts global options after the subcommand", async () => {
  let seen: GlobalOptions | undefined;
  let called = false;
  const context: Context = {
    json: false,
    contract: () => CONTRACT,
    ops: {
      restoreArchived: async () => {
        called = true;
        return {
          mode: "dry-run",
          network: "testnet",
          contract: CONTRACT,
          method: "get_config",
          source: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          archivedEntries: [],
        };
      },
    } as Context["ops"],
  };

  const program = buildProgram((options) => {
    seen = options;
    return context;
  }).exitOverride();

  await program.parseAsync(
    ["node", "inverse-ops", "restore", "archived", CONTRACT, "get_config", "--rpc-url", "http://localhost:8000/rpc"],
    { from: "node" },
  );

  assert.equal(seen?.rpcUrl, "http://localhost:8000/rpc");
  assert.equal(called, true);
});
