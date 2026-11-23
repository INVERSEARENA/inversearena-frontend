import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmSubmit } from "../src/safety.js";

const base = { action: "resolve_round on C…", confirmFlag: false, interactive: false };

test("testnet and standalone submit without confirmation", async () => {
  await confirmSubmit({ ...base, network: "testnet" });
  await confirmSubmit({ ...base, network: "standalone" });
});

test("mainnet without a terminal or --confirm-mainnet is refused", async () => {
  await assert.rejects(confirmSubmit({ ...base, network: "mainnet" }), /Refusing to submit .* on MAINNET without a terminal/);
});

test("--confirm-mainnet allows scripted mainnet submits", async () => {
  await confirmSubmit({ ...base, network: "mainnet", confirmFlag: true });
});

test("the interactive prompt needs the word mainnet typed exactly", async () => {
  let asked = "";
  await confirmSubmit({ ...base, network: "mainnet", interactive: true, ask: async (q) => ((asked = q), "mainnet") });
  assert.match(asked, /About to submit resolve_round on C… on MAINNET/);
  await assert.rejects(
    confirmSubmit({ ...base, network: "mainnet", interactive: true, ask: async () => "y" }),
    /Mainnet submission cancelled/,
  );
});
