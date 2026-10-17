import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("generate-env-examples script", () => {
  it("passes drift check on clean generated files", () => {
    const output = execSync("node scripts/generate-env-examples.mjs --check", {
      cwd: root,
      encoding: "utf8",
    });
    assert.match(output, /All \.env\.example files are up to date/);
  });

  it("regenerates .env.example files without error", () => {
    const output = execSync("node scripts/generate-env-examples.mjs", {
      cwd: root,
      encoding: "utf8",
    });
    assert.match(output, /Successfully generated/);
  });
});
