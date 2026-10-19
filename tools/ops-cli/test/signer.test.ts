import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { parseSigner, SignerError } from "../src/signer.js";

const keypair = Keypair.random();
const secret = keypair.secret();

test("env: reads the seed from the named variable and never describes it", async () => {
  const signer = parseSigner("env:OPS_KEY", { OPS_KEY: secret });
  assert.equal(await signer.publicKey(), keypair.publicKey());
  assert.equal(signer.description, "key from $OPS_KEY");
  assert.ok(!signer.description.includes(secret));
});

test("env: an unset or invalid variable fails without echoing the value", () => {
  assert.throws(() => parseSigner("env:MISSING", {}), /Environment variable MISSING is not set/);
  const leaked = "SNOTAREALSEEDBUTSECRETLOOKING";
  assert.throws(
    () => parseSigner("env:OPS_KEY", { OPS_KEY: leaked }),
    (error: unknown) => error instanceof SignerError && !error.message.includes(leaked),
  );
});

test("file: requires owner-only permissions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-cli-"));
  const path = join(dir, "ops.key");
  writeFileSync(path, `${secret}\n`);
  chmodSync(path, 0o644);
  assert.throws(() => parseSigner(`file:${path}`), /readable by other users; run `chmod 600/);
  chmodSync(path, 0o600);
  assert.equal(await parseSigner(`file:${path}`).publicKey(), keypair.publicKey());
});

test("a seed passed directly is refused, with what to do instead", () => {
  assert.throws(() => parseSigner(secret), /Never pass a secret seed on the command line/);
});

test("ledger parses an account index; unknown kinds are rejected", () => {
  assert.equal(parseSigner("ledger").description, "Ledger 44'/148'/0'");
  assert.equal(parseSigner("ledger:3").description, "Ledger 44'/148'/3'");
  assert.throws(() => parseSigner("ledger:-1"), /ledger\[:<account index>\]/);
  assert.throws(() => parseSigner("vault:x"), /Unknown signer "vault"/);
});
