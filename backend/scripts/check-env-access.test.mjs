import assert from "node:assert/strict";
import { test } from "node:test";
import { findEnvAccesses } from "./check-env-access.mjs";

const lines = (text) => findEnvAccesses("probe.ts", text).map((hit) => hit.line);

test("flags property, element and destructured access", () => {
  assert.deepEqual(lines('const a = process.env.FOO;\nconst b = process["env"];\nconst { env } = process;\n'), [1, 2, 3]);
});

test("flags process.env passed as a value", () => {
  assert.deepEqual(lines("load(process.env);\n"), [1]);
});

test("ignores comments, strings and other objects' env", () => {
  assert.deepEqual(
    lines('// process.env.FOO\n/* process.env */\nconst s = "process.env";\nconst e = config.env;\nconst { argv } = process;\n'),
    [],
  );
});
