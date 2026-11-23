import assert from "node:assert/strict";
import { test } from "node:test";
import { renderEnvExample } from "./env-example";

const render = (vars: Parameters<typeof renderEnvExample>[0]["vars"]) =>
  renderEnvExample({ schemaPath: "app/env.ts", vars }).split("\n");

test("names the schema it was generated from", () => {
  assert.match(render({})[0] ?? "", /^# Generated from app\/env\.ts by scripts\/env-example\.ts/);
});

test("writes required variables uncommented and optional ones commented out", () => {
  const lines = render({
    REQUIRED: { section: "A", description: "Needed.", required: true, example: "x" },
    OPTIONAL: { section: "A", description: "Tunable.", default: "5" },
  });
  assert.ok(lines.includes("REQUIRED=x"));
  assert.ok(lines.includes("# Required."));
  assert.ok(lines.includes("# OPTIONAL=5"));
  assert.ok(lines.includes("# Default: 5."));
});

test("leaves a secret without an example empty", () => {
  const lines = render({ KEY: { section: "A", description: "Signing key.", required: true, secret: true } });
  assert.ok(lines.includes("KEY="));
  assert.ok(lines.includes("# Required. Secret: never commit a real value."));
});

test("emits one heading per section, in declaration order", () => {
  const headings = render({
    A1: { section: "Alpha", description: "a" },
    B1: { section: "Beta", description: "b" },
    A2: { section: "Beta", description: "c" },
  }).filter((line) => line.startsWith("# ── "));
  assert.deepEqual(
    headings.map((line) => line.split(" ")[2]),
    ["Alpha", "Beta"],
  );
});

test("wraps long descriptions at 80 columns", () => {
  const lines = render({ X: { section: "A", description: "word ".repeat(40) } });
  assert.ok(lines.every((line) => line.length <= 80 || line.startsWith("# Generated")));
});
