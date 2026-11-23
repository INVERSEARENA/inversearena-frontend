import assert from "node:assert/strict";
import { test } from "node:test";
import { Account, Keypair, SorobanDataBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { decodeContractError, Ops } from "../src/ops.js";
import type { Deployment } from "../src/manifest.js";
import type { Signer } from "../src/signer.js";
import { ARENA_LIKE_SPEC, CONTRACT } from "./fixtures.js";

const deployment = (network: Deployment["network"] = "testnet"): Deployment => ({
  source: "test",
  network,
  networkPassphrase: network === "mainnet" ? "Public Global Stellar Network ; September 2015" : "Test SDF Network ; September 2015",
  rpcUrl: "http://localhost:8000/rpc",
  contracts: { factory: CONTRACT },
});

/** A fake RPC: records calls, answers simulations with `simulation`. */
function fakeServer(simulation: object) {
  const calls: string[] = [];
  const server = {
    calls,
    async simulateTransaction() {
      calls.push("simulate");
      return { id: "1", latestLedger: 10, events: [], _parsed: true, ...simulation };
    },
    async getAccount(address: string) {
      calls.push("getAccount");
      return new Account(address, "1");
    },
    async sendTransaction() {
      calls.push("send");
      return { status: "PENDING", hash: "ab".repeat(32) };
    },
    async pollTransaction() {
      calls.push("poll");
      return { status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 11, returnValue: xdr.ScVal.scvVoid() };
    },
  };
  return server;
}

const success = {
  transactionData: new SorobanDataBuilder(),
  minResourceFee: "12345",
  result: { auth: [], retval: xdr.ScVal.scvVoid() },
};

function ops(server: object, extra: Partial<ConstructorParameters<typeof Ops>[0]> = {}) {
  const instance = new Ops({
    deployment: deployment(),
    server: server as rpc.Server,
    submit: false,
    confirmMainnet: false,
    interactive: false,
    ...extra,
  });
  // Serve the spec from the fixture instead of the network.
  instance.spec = async () => ARENA_LIKE_SPEC;
  return instance;
}

const keypair = Keypair.random();
const signer: Signer = {
  description: "test key",
  publicKey: async () => keypair.publicKey(),
  sign: async (tx) => tx.sign(keypair),
};

test("mutations are dry runs by default: simulated, never sent", async () => {
  const server = fakeServer(success);
  const report = await ops(server, { signer }).mutate(CONTRACT, "arena", "resolve_round");
  assert.equal(report.mode, "dry-run");
  assert.equal(report.minResourceFee, "12345");
  assert.equal(report.source, keypair.publicKey());
  assert.deepEqual(server.calls, ["simulate"]);
});

test("--submit signs, sends and waits", async () => {
  const server = fakeServer(success);
  const report = await ops(server, { signer, submit: true }).mutate(CONTRACT, "arena", "resolve_round");
  assert.equal(report.mode, "submitted");
  assert.equal(report.txHash, "ab".repeat(32));
  assert.deepEqual(server.calls, ["getAccount", "simulate", "send", "poll"]);
});

test("--submit without a signer is refused before any RPC call", async () => {
  const server = fakeServer(success);
  await assert.rejects(ops(server, { submit: true }).mutate(CONTRACT, "arena", "resolve_round"), /--submit needs a --signer/);
  assert.deepEqual(server.calls, []);
});

test("--submit on mainnet without confirmation never sends", async () => {
  const server = fakeServer(success);
  const mainnet = ops(server, { signer, submit: true, deployment: deployment("mainnet") });
  await assert.rejects(mainnet.mutate(CONTRACT, "arena", "resolve_round"), /MAINNET/);
  assert.ok(!server.calls.includes("send"));
});

test("a contract error in simulation is named from the spec", async () => {
  const server = fakeServer({ error: "HostError: Error(Contract, #12)\n\nEvent log..." });
  await assert.rejects(ops(server).mutate(CONTRACT, "arena", "resolve_round"), /contract error GracePeriodNotElapsed \(#12\)/);
});

test("decodeContractError falls back to the code for an unknown case", () => {
  assert.deepEqual(decodeContractError(ARENA_LIKE_SPEC, "Error(Contract, #99)"), { code: 99, name: "#99" });
  assert.equal(decodeContractError(ARENA_LIKE_SPEC, "Error(Budget, ExceededLimit)"), undefined);
});
