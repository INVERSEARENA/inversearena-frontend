import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as sdk from "@stellar/stellar-sdk";

const { Contract, Address, xdr } = sdk as any;

test("stellar XDR golden vectors for join/commit/reveal/claim", () => {
  const fixturePath = path.resolve(process.cwd(), "..", "shared", "stellar-xdr-golden-vectors.json");
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const c = new Contract(fixture.contractId);
  const addr = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const zero = Buffer.alloc(32, 0);
  const actual = {
    join_arena: c.call("join_arena", new Address(addr).toScVal()).toXDR("base64"),
    submit_commitment: c.call("submit_commitment", new Address(addr).toScVal(), xdr.ScVal.scvU32(1), xdr.ScVal.scvBytes(zero)).toXDR("base64"),
    reveal_choice: c.call("reveal_choice", new Address(addr).toScVal(), xdr.ScVal.scvU32(1), xdr.ScVal.scvU32(1), xdr.ScVal.scvBytes(zero)).toXDR("base64"),
    claim: c.call("claim", new Address(addr).toScVal()).toXDR("base64"),
  };
  assert.deepEqual(actual, fixture.operations);
});
