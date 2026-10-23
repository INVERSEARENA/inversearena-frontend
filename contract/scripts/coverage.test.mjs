import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { aggregate, check, ratchet, renderMarkdown } from "./coverage.mjs";

const ROOT = join("/repo", "contract");

const file = (path, lines, branches, functions = [1, 1]) => ({
  filename: join(ROOT, path),
  summary: {
    lines: { covered: lines[0], count: lines[1] },
    branches: { covered: branches[0], count: branches[1] },
    functions: { covered: functions[0], count: functions[1] },
  },
});

const summary = (...files) => ({ data: [{ files }] });

test("aggregate sums files per crate and ignores paths outside the workspace", () => {
  const crates = aggregate(
    summary(
      file("arena/src/lib.rs", [80, 100], [8, 10]),
      file("arena/src/storage.rs", [10, 20], [0, 0]),
      file("staking/src/lib.rs", [5, 10], [1, 2]),
      { ...file("x.rs", [1, 1], [0, 0]), filename: "/rustc/library/core/src/x.rs" },
    ),
    ROOT,
  );
  assert.deepEqual(Object.keys(crates), ["arena", "staking"]);
  assert.deepEqual(crates.arena.lines, { covered: 90, count: 120 });
  assert.deepEqual(crates.arena.branches, { covered: 8, count: 10 });
});

test("check passes at the threshold and fails just below it", () => {
  const crates = aggregate(summary(file("arena/src/lib.rs", [80, 100], [8, 10])), ROOT);
  assert.equal(check(crates, { crates: { arena: { lines: 80, branches: 80 } } }).failed, false);
  const result = check(crates, { crates: { arena: { lines: 81, branches: 80 } } });
  assert.equal(result.failed, true);
  assert.deepEqual(result.rows[0].problems, ["lines 80.00% < 81%"]);
});

test("a crate with no branches counts as fully branch-covered", () => {
  const crates = aggregate(summary(file("oracle/src/lib.rs", [10, 10], [0, 0])), ROOT);
  assert.equal(check(crates, { crates: { oracle: { lines: 100, branches: 100 } } }).failed, false);
});

test("a crate missing a threshold, or missing from the report, fails", () => {
  const crates = aggregate(summary(file("arena/src/lib.rs", [1, 1], [1, 1])), ROOT);
  const result = check(crates, { crates: { staking: { lines: 1, branches: 1 } } });
  assert.equal(result.failed, true);
  assert.deepEqual(
    result.rows.map((row) => [row.crate, row.problems[0]]),
    [
      ["arena", "no threshold (run with --ratchet)"],
      ["staking", "no coverage data"],
    ],
  );
});

test("check notes when coverage has risen past the threshold", () => {
  const crates = aggregate(summary(file("arena/src/lib.rs", [95, 100], [9, 10])), ROOT);
  const { rows, failed } = check(crates, { crates: { arena: { lines: 80, branches: 90 } } });
  assert.equal(failed, false);
  assert.deepEqual(rows[0].notes, ["lines can ratchet to 95%"]);
});

test("ratchet raises to the floor of current coverage and never lowers", () => {
  const crates = aggregate(summary(file("arena/src/lib.rs", [957, 1000], [5, 10]), file("payout/src/lib.rs", [1, 3], [1, 3])), ROOT);
  const next = ratchet(crates, { version: 1, crates: { arena: { lines: 90, branches: 70 } } });
  assert.deepEqual(next.crates.arena, { lines: 95, branches: 70 });
  assert.deepEqual(next.crates.payout, { lines: 33, branches: 33 });
  assert.equal(next.version, 1);
});

test("the markdown summary lists each crate with its status", () => {
  const crates = aggregate(summary(file("arena/src/lib.rs", [1, 2], [1, 2])), ROOT);
  const markdown = renderMarkdown(check(crates, { crates: { arena: { lines: 60, branches: 50 } } }));
  assert.match(markdown, /❌ Coverage below threshold/);
  assert.match(markdown, /\| `arena` \| 50\.00% \(1\/2\) \| 50\.00% \(1\/2\) \| 100\.00% \(1\/1\) \| 60% \| 50% \| ❌ lines 50\.00% < 60% \|/);
});
