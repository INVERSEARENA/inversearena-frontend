import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { contractIdFor, findDefaultManifest, ManifestError, parseManifest } from "../src/manifest.js";
import { CONTRACT } from "./fixtures.js";

const valid = () => ({
  schemaVersion: 1,
  network: "testnet",
  networkPassphrase: "Test SDF Network ; September 2015",
  rpcUrl: "https://soroban-testnet.stellar.org",
  contracts: { factory: { id: CONTRACT }, rwa_adapter: { id: CONTRACT } },
});

test("the repo's committed manifest parses", () => {
  const path = findDefaultManifest(import.meta.dirname);
  assert.ok(path, "contract/deployment-manifest.json found from tools/ops-cli");
  const deployment = parseManifest(JSON.parse(readFileSync(path, "utf8")), path);
  assert.equal(deployment.network, "testnet");
  assert.match(deployment.contracts.factory!, /^C/);
});

test("every network problem is reported at once", () => {
  const bad = { ...valid(), schemaVersion: 2, networkPassphrase: "wrong", rpcUrl: "ftp://x" };
  assert.throws(() => parseManifest(bad, "m.json"), (error: unknown) => {
    assert.ok(error instanceof ManifestError);
    for (const fragment of ["schemaVersion must be 1", "networkPassphrase does not match", "rpcUrl must be"]) {
      assert.ok(error.message.includes(fragment), fragment);
    }
    return true;
  });
});

test("a malformed contract id fails only the commands that use it", () => {
  const deployment = parseManifest({ ...valid(), contracts: { factory: { id: CONTRACT }, staking: { id: "C123" } } }, "m.json");
  assert.equal(contractIdFor(deployment, "factory"), CONTRACT);
  assert.throws(() => contractIdFor(deployment, "staking"), /contracts\.staking\.id in m\.json is not a valid contract id/);
});

test("a mainnet manifest needs the mainnet passphrase", () => {
  assert.throws(() => parseManifest({ ...valid(), network: "mainnet" }, "m.json"), /does not match network "mainnet"/);
});

test("contract ids come from the manifest, with aliases for the vault", () => {
  const deployment = parseManifest(valid(), "m.json");
  assert.equal(contractIdFor(deployment, "factory"), CONTRACT);
  assert.equal(contractIdFor(deployment, "vault"), CONTRACT);
});

test("an override wins but is validated", () => {
  const deployment = parseManifest(valid(), "m.json");
  const other = `C${"B".repeat(55)}`;
  assert.equal(contractIdFor(deployment, "factory", other), other);
  assert.throws(() => contractIdFor(deployment, "factory", "Cxyz"), /--factory must be a contract id/);
});

test("a kind missing from the manifest names the flag to pass", () => {
  assert.throws(() => contractIdFor(parseManifest(valid(), "m.json"), "oracle"), /No oracle contract in m\.json.*Pass --oracle <C\.\.\.>/);
});

test("findDefaultManifest walks up to the repo root", () => {
  assert.equal(findDefaultManifest(join(import.meta.dirname, "..", "src")), join(import.meta.dirname, "..", "..", "..", "contract", "deployment-manifest.json"));
});
