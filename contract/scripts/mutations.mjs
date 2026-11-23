#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONTRACT = join(dirname(fileURLToPath(import.meta.url)), "..");
const THRESHOLDS = join(CONTRACT, "mutation-thresholds.json");
const DEFAULT_INPUT = join(CONTRACT, "mutants.out");

const SUMMARY = { CaughtMutant: "caught", MissedMutant: "missed", Timeout: "missed", Unviable: "excluded" };

function normalizePath(path) {
  return String(path ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^contract\//, "");
}

function mutantFromOutcome(outcome) {
  const scenario = outcome?.scenario;
  if (!scenario || typeof scenario !== "object") return null;
  const wrapper = scenario.Mutant ?? scenario.mutant;
  if (!wrapper || typeof wrapper !== "object") return null;
  return wrapper.mutant ?? wrapper;
}

export function classify(mutants, outcomes) {
  const definitions = new Map(mutants.map((mutant) => [mutant.name, mutant]));
  const records = new Map();

  const add = (mutant, summary, problem, timeout) => {
    const name = mutant.name ?? mutant.mutant_id ?? problem;
    if (records.has(name)) return;
    const definition = definitions.get(name);
    const source = definition ?? mutant;
    const outcome = SUMMARY[summary] ?? "unresolved";
    const problems = [];
    if (!definition) problems.push("no matching mutant definition");
    if (outcome === "unresolved") problems.push(`unresolved outcome: ${summary ?? "missing"}`);
    if (problem) problems.push(problem);
    records.set(name, {
      name,
      file: normalizePath(source.file),
      function: source.function?.function_name ?? "",
      outcome,
      timeout: Boolean(timeout),
      summary: summary ?? "missing",
      problems,
    });
  };

  for (const outcome of outcomes?.outcomes ?? []) {
    const mutant = mutantFromOutcome(outcome);
    if (!mutant) continue;
    add(mutant, outcome.summary, null, outcome.summary === "Timeout");
  }
  for (const mutant of mutants) {
    if (!records.has(mutant.name)) add(mutant, undefined, "no outcome", false);
  }
  return [...records.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function loadReports(input = DEFAULT_INPUT) {
  const dir = input.endsWith(".json") ? dirname(input) : input;
  const mutantsPath = input.endsWith(".json") ? input : join(dir, "mutants.json");
  const outcomesPath = join(dir, "outcomes.json");
  return classify(
    JSON.parse(readFileSync(mutantsPath, "utf8")),
    JSON.parse(readFileSync(outcomesPath, "utf8")),
  );
}

function matchesFile(pattern, file) {
  const expected = normalizePath(pattern);
  return expected === "*" || expected === "**" || file === expected || file.endsWith(`/${expected}`);
}

function matchesFunction(patterns, name) {
  if (!patterns?.length) return true;
  const short = name.split("::").pop();
  return patterns.some((pattern) => pattern === name || pattern === short || short.endsWith(`::${pattern}`));
}

export function groupRecords(records, thresholds) {
  return Object.entries(thresholds.groups ?? {}).map(([name, group]) => {
    const selected = records.filter(
      (record) =>
        (group.files ?? ["*"]).some((pattern) => matchesFile(pattern, record.file)) &&
        matchesFunction(group.functions, record.function),
    );
    const viable = selected.filter((record) => record.outcome !== "excluded");
    const caught = viable.filter((record) => record.outcome === "caught").length;
    const timeouts = viable.filter((record) => record.timeout).length;
    const missed = viable.filter((record) => record.outcome === "missed" && !record.timeout).length;
    const unresolved = viable.filter((record) => record.outcome === "unresolved").length;
    const excluded = selected.length - viable.length;
    const caughtPct = viable.length === 0 ? 0 : (caught / viable.length) * 100;
    const minimumPct = group.minimum_caught_pct ?? 0;
    const minimumMutants = group.minimum_mutants ?? 0;
    const problems = [];
    const notes = [];
    if (selected.length === 0) problems.push("no mutant data");
    else if (viable.length === 0) problems.push("no viable mutants");
    if (viable.length < minimumMutants) problems.push(`${viable.length} viable mutants < minimum ${minimumMutants}`);
    if (viable.length > 0 && caughtPct < minimumPct) problems.push(`caught ${caughtPct.toFixed(2)}% < ${minimumPct}%`);
    if (timeouts > 0) problems.push(`${timeouts} timeout(s)`);
    if (unresolved > 0) problems.push(`${unresolved} unresolved outcome(s)`);
    if (!group.report_only && problems.length === 0 && Math.floor(caughtPct) > minimumPct) {
      notes.push(`caught ${Math.floor(caughtPct)}% can ratchet`);
    }
    return {
      name,
      files: group.files ?? ["*"],
      functions: group.functions ?? [],
      reportOnly: Boolean(group.report_only),
      total: selected.length,
      viable: viable.length,
      caught,
      missed,
      timeouts,
      excluded,
      unresolved,
      caughtPct,
      minimumPct,
      minimumMutants,
      problems,
      notes,
    };
  });
}

export function checkRecords(records, thresholds) {
  const rows = groupRecords(records, thresholds);
  const failed =
    rows.some((row) => !row.reportOnly && row.problems.length > 0) ||
    records.some((record) => record.outcome === "unresolved");
  return { rows, failed };
}

export function ratchet(rows, thresholds) {
  const next = structuredClone(thresholds);
  for (const row of rows) {
    const group = next.groups?.[row.name];
    if (!group || group.report_only || row.viable === 0) continue;
    if (group.minimum_caught_pct !== undefined) {
      group.minimum_caught_pct = Math.max(group.minimum_caught_pct, Math.floor(row.caughtPct));
    }
    if (group.minimum_mutants !== undefined) {
      group.minimum_mutants = Math.max(group.minimum_mutants, row.viable);
    }
  }
  return next;
}

export function renderMarkdown({ rows, failed }) {
  const lines = [
    "## Contract mutation testing (#1798)",
    "",
    failed ? "FAIL: mutation thresholds are not met." : "PASS: every gated mutation group meets its thresholds.",
    "",
    "| Group | Files | Functions | Viable | Caught | Missed | Timeouts | Unviable | Unresolved | Caught % | Min % | Min mutants | Status |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const row of rows) {
    const status = row.problems.length ? `FAIL: ${row.problems.join("; ")}` : row.notes.length ? row.notes.join("; ") : "OK";
    lines.push(
      `| \`${row.name}\` | \`${row.files.join(", ")}\` | \`${row.functions.join(", ")}\` | ${row.viable} | ${row.caught} | ${row.missed} | ${row.timeouts} | ${row.excluded} | ${row.unresolved} | ${row.caughtPct.toFixed(2)}% | ${row.reportOnly ? "—" : `${row.minimumPct}%`} | ${row.reportOnly ? "—" : row.minimumMutants} | ${status} |`,
    );
  }
  lines.push("", "Unviable mutants are excluded from the caught percentage. Timeouts count as missed and fail gated groups.", "");
  return lines.join("\n");
}

export function writeSummary(contractDir, markdown) {
  const summaryPath = join(contractDir, "target", "mutations", "summary.md");
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, markdown);
  return summaryPath;
}

function main(argv) {
  const inputFlag = argv.indexOf("--input");
  const input = inputFlag >= 0 ? argv[inputFlag + 1] : DEFAULT_INPUT;
  const records = loadReports(input);
  const thresholds = JSON.parse(readFileSync(THRESHOLDS, "utf8"));

  if (argv.includes("--ratchet")) {
    writeFileSync(THRESHOLDS, `${JSON.stringify(ratchet(checkRecords(records, thresholds).rows, thresholds), null, 2)}\n`);
    console.log(`Ratcheted ${THRESHOLDS}`);
    return 0;
  }

  const result = checkRecords(records, thresholds);
  const markdown = renderMarkdown(result);
  writeSummary(CONTRACT, markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  console.log(markdown);
  return result.failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
