import assert from "node:assert/strict";
import { test } from "node:test";
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { ArgumentError, encodeArgs, toJsonSafe } from "../src/encode.js";
import { ACCOUNT, ARENA_LIKE_SPEC as spec, CONTRACT } from "./fixtures.js";

const encode = (method: string, ...args: string[]) => encodeArgs(spec, method, args);
const kinds = (vals: xdr.ScVal[]) => vals.map((v) => v.switch().name);

test("u32 arguments encode as scvU32", () => {
  const vals = encode("get_arenas", "0", "50");
  assert.deepEqual(kinds(vals), ["scvU32", "scvU32"]);
  assert.deepEqual(vals.map((v) => scValToNative(v)), [0, 50]);
});

test("i128 accepts values beyond Number precision and underscores", () => {
  const [, amount] = encode("deposit", ACCOUNT, "170_141_183_460_469_231_731_687_303_715_884_105_727");
  assert.equal(amount!.switch().name, "scvI128");
  assert.equal(scValToNative(amount!), 2n ** 127n - 1n);
});

test("integers are range-checked against their spec type", () => {
  assert.throws(() => encode("get_arenas", "-1", "5"), /offset: -1 is out of range for u32/);
  assert.throws(() => encode("get_arenas", "4294967296", "5"), /out of range for u32/);
  assert.throws(() => encode("deposit", ACCOUNT, (2n ** 127n).toString()), /out of range for i128/);
  assert.throws(() => encode("get_arenas", "1.5", "5"), /offset: expected an integer \(u32\)/);
});

test("u64 encodes as scvU64", () => {
  assert.deepEqual(kinds(encode("set_activation_delay", "86400")), ["scvU64"]);
});

test("addresses accept accounts and contracts and reject anything else", () => {
  assert.equal(encode("deposit", ACCOUNT, "1")[0]!.switch().name, "scvAddress");
  assert.equal(encode("deposit", CONTRACT, "1")[0]!.switch().name, "scvAddress");
  assert.throws(() => encode("deposit", "GABC", "1"), /from: expected a G\.\.\. account or C\.\.\. contract address/);
});

test("bool and symbol", () => {
  const [paused, reason] = encode("set_global_pause", "true", "incident_42");
  assert.equal(paused!.b(), true);
  assert.equal(reason!.sym().toString(), "incident_42");
  assert.throws(() => encode("set_global_pause", "yes", "x"), /paused: expected true or false/);
  assert.throws(() => encode("set_global_pause", "true", "has space"), /reason: a symbol is 1-32/);
});

test("BytesN<32> takes hex with or without 0x and checks the length", () => {
  const hash = "ab".repeat(32);
  assert.equal(Buffer.from(encode("upgrade", hash)[0]!.bytes()).toString("hex"), hash);
  assert.equal(Buffer.from(encode("upgrade", `0x${hash}`)[0]!.bytes()).toString("hex"), hash);
  assert.throws(() => encode("upgrade", "abcd"), /new_wasm_hash: expected 32 bytes, got 2/);
  assert.throws(() => encode("upgrade", "zz".repeat(32)), /expected hex bytes/);
});

test("a unit-variant union (Choice) takes the variant name", () => {
  const [, choice] = encode("reveal_choice", ACCOUNT, "Tails");
  assert.equal(choice!.switch().name, "scvVec");
  assert.equal(choice!.vec()![0]!.sym().toString(), "Tails");
  assert.throws(() => encode("reveal_choice", ACCOUNT, "Edge"), /choice: expected one of Heads, Tails/);
});

test("a C-style enum takes the case name or its value", () => {
  assert.equal(scValToNative(encode("set_status", "Finished")[0]!), 1);
  assert.equal(scValToNative(encode("set_status", "0")[0]!), 0);
  assert.throws(() => encode("set_status", "Paused"), /expected one of Active, Finished/);
});

test("Option<u32> takes a value or none", () => {
  assert.equal(encode("maybe_round", "none")[0]!.switch().name, "scvVoid");
  assert.equal(scValToNative(encode("maybe_round", "3")[0]!), 3);
});

test("the argument count must match the spec, with usage in the error", () => {
  assert.throws(() => encode("get_arenas", "0"), /get_arenas takes 2 argument\(s\): get_arenas <offset> <limit>/);
  assert.deepEqual(encode("resolve_round"), []);
});

test("an unknown method lists the available ones", () => {
  assert.throws(() => encode("resolve"), (error: unknown) => {
    assert.ok(error instanceof ArgumentError);
    assert.match(error.message, /Unknown method "resolve"\. Available: .*resolve_round/);
    return true;
  });
});

test("toJsonSafe turns bigint and bytes into strings", () => {
  assert.deepEqual(toJsonSafe({ a: 1n, b: [2n], c: new Uint8Array([1, 255]), d: new Map([["k", 3n]]) }), {
    a: "1",
    b: ["2"],
    c: "01ff",
    d: { k: "3" },
  });
});
