import assert from "node:assert/strict";
import { test } from "node:test";
import { bless, compare, renderMarkdown } from "./cost-bench.mjs";

const result = (overrides = {}) => ({
  name: "arena/join_arena",
  players: 10,
  instructions: 1_000_000,
  mem_bytes: 500_000,
  read_entries: 10,
  write_entries: 5,
  read_bytes: 2_000,
  write_bytes: 1_000,
  events_bytes: 100,
  fee_stroops: 12_345,
  ...overrides,
});

const baselineFor = (...results) => bless(null, results, { toolchain: "rustc 1.0.0", sorobanSdk: "22.0.0" });

test("identical results pass", () => {
  const { failed, rows } = compare(baselineFor(result()), [result()]);
  assert.equal(failed, false);
  assert.deepEqual(rows[0].problems, []);
});

test("an instruction increase within the threshold passes", () => {
  const { failed } = compare(baselineFor(result()), [result({ instructions: 1_050_000 })]);
  assert.equal(failed, false);
});

test("an instruction increase over the threshold fails", () => {
  const { failed, rows } = compare(baselineFor(result()), [result({ instructions: 1_050_001 })]);
  assert.equal(failed, true);
  assert.match(rows[0].problems[0], /^instructions \+5\.00% > 5%/);
});

test("any extra ledger entry fails (0% threshold)", () => {
  const { failed, rows } = compare(baselineFor(result()), [result({ write_entries: 6 })]);
  assert.equal(failed, true);
  assert.match(rows[0].problems[0], /^write_entries/);
});

test("per-metric thresholds in the baseline override the defaults", () => {
  const baseline = { ...baselineFor(result()), thresholds: { instructions: 20 } };
  assert.equal(compare(baseline, [result({ instructions: 1_150_000 })]).failed, false);
});

test("improvements are noted, not failed", () => {
  const { failed, rows } = compare(baselineFor(result()), [result({ instructions: 800_000 })]);
  assert.equal(failed, false);
  assert.match(rows[0].notes[0], /instructions improved -20\.00%/);
});

test("a benchmark missing from the baseline fails until blessed", () => {
  const { failed, rows } = compare(baselineFor(result()), [result(), result({ players: 50 })]);
  assert.equal(failed, true);
  assert.equal(rows.find((row) => row.players === 50).problems[0], "not in baseline (run with --bless)");
});

test("a baseline benchmark that no longer runs fails", () => {
  const { failed, rows } = compare(baselineFor(result(), result({ name: "staking/stake" })), [result()]);
  assert.equal(failed, true);
  assert.equal(rows.at(-1).problems[0], "missing from results");
});

test("newly crossing a network limit fails even within the regression threshold", () => {
  const near = result({ instructions: 99_000_000 });
  const { failed, rows } = compare(baselineFor(near), [result({ instructions: 100_000_001 })]);
  assert.equal(failed, true);
  assert.ok(rows[0].problems.some((p) => p.includes("exceeds network limit")));
});

test("a result already over a network limit in the baseline is reported as known", () => {
  const over = result({ instructions: 300_000_000 });
  const { failed, rows } = compare(baselineFor(over), [over]);
  assert.equal(failed, false);
  assert.deepEqual(rows[0].notes, ["instructions over network limit (known)"]);
});

test("bless keeps custom thresholds and sorts benchmarks numerically by players", () => {
  const blessed = bless({ thresholds: { instructions: 2 } }, [result({ players: 100 }), result({ players: 10 })], {
    toolchain: "rustc 1.0.0",
    sorobanSdk: "22.0.0",
  });
  assert.equal(blessed.thresholds.instructions, 2);
  assert.deepEqual(Object.keys(blessed.benchmarks), ["arena/join_arena@10", "arena/join_arena@100"]);
});

test("the markdown summary marks failing rows", () => {
  const markdown = renderMarkdown(compare(baselineFor(result()), [result({ instructions: 2_000_000 })]));
  assert.match(markdown, /❌ Cost regression/);
  assert.match(markdown, /\| `arena\/join_arena` \| 10 \| 2,000,000 \(\+100\.00%\)/);
});
