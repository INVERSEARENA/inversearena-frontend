import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { decodeArenaEvent, filterRound } from "../src/events.js";
import { ACCOUNT } from "./fixtures.js";

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
const tuple = (...vals: xdr.ScVal[]) => xdr.ScVal.scvVec(vals);
let seq = 0;
const event = (topic: xdr.ScVal[], value: xdr.ScVal) => ({
  id: `0000-${++seq}`,
  ledger: 100 + seq,
  ledgerClosedAt: "2026-10-19T00:00:00Z",
  topic,
  value,
});

const resolved = event([sym("arena"), sym("resolved")], tuple(u32(1), u32(2), u32(7), u32(3)));
const commit = event([sym("arena"), sym("commit"), nativeToScVal(ACCOUNT, { type: "address" })], tuple(u32(1), u32(3)));
const v2 = event([sym("arena"), sym("rslvd2"), u32(2)], tuple(u32(2), u32(4), u32(6), u32(6), u32(4)));
const joined = event([sym("arena"), sym("join"), nativeToScVal(ACCOUNT, { type: "address" })], tuple(u32(1), u32(10)));

test("decodes data fields after the schema version", () => {
  assert.deepEqual(decodeArenaEvent(resolved).fields, { schema_version: 1, round: 2, eliminated: 7, survivors: 3 });
  assert.equal(decodeArenaEvent(resolved).event, "round_resolved");
});

test("decodes indexed topics after the event name", () => {
  const decoded = decodeArenaEvent(commit);
  assert.equal(decoded.event, "commitment_submitted");
  assert.deepEqual(decoded.fields, { schema_version: 1, player: ACCOUNT, round: 3 });
  assert.deepEqual(decodeArenaEvent(v2).fields, { schema_version: 2, round: 2, heads: 4, tails: 6, eliminated: 6, survivors: 4 });
});

test("an unknown event is kept raw rather than dropped", () => {
  const decoded = decodeArenaEvent(event([sym("arena"), sym("future_evt")], tuple(u32(1))));
  assert.equal(decoded.event, "future_evt");
  assert.deepEqual(decoded.raw, { topics: ["arena", "future_evt"], data: [1] });
});

test("--round keeps only events whose round matches", () => {
  const all = [resolved, commit, v2, joined].map(decodeArenaEvent);
  assert.deepEqual(filterRound(all, 2).map((e) => e.event), ["round_resolved", "round_resolved_v2"]);
  assert.deepEqual(filterRound(all, 3).map((e) => e.event), ["commitment_submitted"]);
});
