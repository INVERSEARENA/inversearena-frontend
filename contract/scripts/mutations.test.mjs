import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkRecords, classify, groupRecords, loadReports, ratchet, renderMarkdown, writeSummary } from "./mutations.mjs";

function mutant(file, functionName, name = `${file}:1:1: replace ${functionName} with ()`) {
  return { name, package: file.split("/")[0], file, function: { function_name: functionName, return_type: "-> ()" }, span: { start: { line: 1, column: 1 } }, replacement: "()", genre: "FnValue" };
}

function outcome(mutantValue, summary) {
  return { scenario: { Mutant: mutantValue }, summary, log_path: "log/x.log", diff_path: "diff/x.diff", phase_results: [] };
}

function fixture(t, mutants, summaries) {
  const dir = mkdtempSync(join(tmpdir(), "mutations-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "mutants.json"), JSON.stringify(mutants));
  writeFileSync(
    join(dir, "outcomes.json"),
    JSON.stringify({ outcomes: summaries.map(([mutantValue, summary]) => outcome(mutantValue, summary)) }),
  );
  return dir;
}

const groupThresholds = (groups) => ({ version: 1, groups });

test("classifies and groups mutants by configured file and function", (t) => {
  const state = mutant("arena/src/state_machine.rs", "can_transition");
  const phase = mutant("arena/src/state_machine.rs", "phase");
  const claim = mutant("arena/src/lib.rs", "ArenaContract::claim");
  const dir = fixture(t, [state, phase, claim], [[state, "CaughtMutant"], [phase, "CaughtMutant"], [claim, "CaughtMutant"]]);
  const thresholds = groupThresholds({
    transitions: { files: ["arena/src/state_machine.rs"], functions: ["can_transition"], minimum_caught_pct: 100, minimum_mutants: 1 },
    settlement: { files: ["arena/src/lib.rs"], functions: ["claim"], minimum_caught_pct: 100, minimum_mutants: 1 },
    global: { files: ["*"], report_only: true },
  });
  const rows = groupRecords(loadReports(dir), thresholds);
  assert.deepEqual(rows.map((row) => [row.name, row.viable, row.caught]), [
    ["transitions", 1, 1],
    ["settlement", 1, 1],
    ["global", 3, 3],
  ]);
});

test("unviable mutants are excluded from the caught percentage", (t) => {
  const caught = mutant("arena/src/state_machine.rs", "can_transition", "caught");
  const unviable = mutant("arena/src/state_machine.rs", "ensure_state", "unviable");
  const dir = fixture(t, [caught, unviable], [[caught, "CaughtMutant"], [unviable, "Unviable"]]);
  const result = checkRecords(loadReports(dir), groupThresholds({
    state: { files: ["arena/src/state_machine.rs"], minimum_caught_pct: 100, minimum_mutants: 1 },
  }));
  assert.equal(result.failed, false);
  assert.deepEqual(
    [result.rows[0].total, result.rows[0].viable, result.rows[0].excluded, result.rows[0].caughtPct],
    [2, 1, 1, 100],
  );
});

test("a timeout is missed, reported separately, and fails a gated group", (t) => {
  const caught = mutant("arena/src/lib.rs", "claim", "caught");
  const timeout = mutant("arena/src/lib.rs", "claim", "timeout");
  const dir = fixture(t, [caught, timeout], [[caught, "CaughtMutant"], [timeout, "Timeout"]]);
  const records = loadReports(dir);
  assert.deepEqual(records.find((record) => record.name === "timeout").outcome, "missed");
  const result = checkRecords(records, groupThresholds({
    settlement: { files: ["arena/src/lib.rs"], functions: ["claim"], minimum_caught_pct: 100, minimum_mutants: 1 },
  }));
  assert.equal(result.failed, true);
  assert.equal(result.rows[0].caughtPct, 50);
  assert.deepEqual([result.rows[0].missed, result.rows[0].timeouts], [0, 1]);
  assert.match(result.rows[0].problems.join("; "), /1 timeout\(s\)/);
});

test("a group below its caught threshold fails", (t) => {
  const mutants = [1, 2, 3].map((n) => mutant("arena/src/state_machine.rs", "can_transition", `m${n}`));
  const dir = fixture(t, mutants, mutants.map((value, index) => [value, index === 0 ? "MissedMutant" : "CaughtMutant"]));
  const result = checkRecords(loadReports(dir), groupThresholds({
    state: { files: ["arena/src/state_machine.rs"], minimum_caught_pct: 100, minimum_mutants: 1 },
  }));
  assert.equal(result.failed, true);
  assert.equal(result.rows[0].caughtPct, (2 / 3) * 100);
  assert.match(result.rows[0].problems.join("; "), /caught 66\.67% < 100%/);
});

test("ratchet raises thresholds to measured values and never lowers them", (t) => {
  const first = mutant("arena/src/state_machine.rs", "can_transition", "first");
  const second = mutant("arena/src/state_machine.rs", "can_transition", "second");
  const dir = fixture(t, [first, second], [[first, "CaughtMutant"], [second, "CaughtMutant"]]);
  const thresholds = groupThresholds({
    high: { files: ["arena/src/state_machine.rs"], minimum_caught_pct: 100, minimum_mutants: 5 },
    low: { files: ["arena/src/state_machine.rs"], minimum_caught_pct: 50, minimum_mutants: 1 },
    global: { files: ["*"], report_only: true },
  });
  const next = ratchet(groupRecords(loadReports(dir), thresholds), thresholds);
  assert.deepEqual(next.groups.high, { files: ["arena/src/state_machine.rs"], minimum_caught_pct: 100, minimum_mutants: 5 });
  assert.deepEqual(next.groups.low, { files: ["arena/src/state_machine.rs"], minimum_caught_pct: 100, minimum_mutants: 2 });
  assert.deepEqual(next.groups.global, { files: ["*"], report_only: true });
  assert.deepEqual(thresholds.groups.low, { files: ["arena/src/state_machine.rs"], minimum_caught_pct: 50, minimum_mutants: 1 });
});

test("a group with no mutants fails via minimum_mutants", (t) => {
  const value = mutant("arena/src/lib.rs", "claim");
  const dir = fixture(t, [value], [[value, "CaughtMutant"]]);
  const result = checkRecords(loadReports(dir), groupThresholds({
    missing: { files: ["payout/src/lib.rs"], minimum_caught_pct: 100, minimum_mutants: 1 },
  }));
  assert.equal(result.failed, true);
  assert.deepEqual(result.rows[0].problems, ["no mutant data", "0 viable mutants < minimum 1"]);
});

test("Success and Failure outcomes fail as unresolved", (t) => {
  const success = mutant("arena/src/lib.rs", "claim", "success");
  const failure = mutant("arena/src/lib.rs", "claim", "failure");
  const dir = fixture(t, [success, failure], [[success, "Success"], [failure, "Failure"]]);
  const records = loadReports(dir);
  assert.deepEqual(records.map((record) => record.outcome), ["unresolved", "unresolved"]);
  const result = checkRecords(records, groupThresholds({
    global: { files: ["*"], report_only: true },
  }));
  assert.equal(result.failed, true);
  assert.match(result.rows[0].problems.join("; "), /2 unresolved outcome\(s\)/);
});

test("writes the markdown summary into target/mutations", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mutations-output-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const value = mutant("arena/src/state_machine.rs", "can_transition");
  const result = checkRecords(classify([value], { outcomes: [{ scenario: { Mutant: value }, summary: "CaughtMutant" }] }), groupThresholds({
    state: { files: ["arena/src/state_machine.rs"], minimum_caught_pct: 100, minimum_mutants: 1 },
  }));
  const markdown = renderMarkdown(result);
  const summaryPath = writeSummary(dir, markdown);
  assert.equal(summaryPath, join(dir, "target", "mutations", "summary.md"));
  assert.equal(readFileSync(summaryPath, "utf8"), markdown);
  assert.match(markdown, /PASS: every gated mutation group meets its thresholds\./);
  assert.match(markdown, /\| `state` \|/);
});
