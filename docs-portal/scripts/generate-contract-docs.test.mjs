import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { collectContractPages, parseRustDocEntries } from "./generate-contract-docs.mjs";

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/contract-docs");
const expectedArena = `# arena contract API

Source: \`contract/arena/src\`

## \`contract/arena/src/lib.rs\`

### pub fn \`initialize\` — line 8

Initialize the arena.

#### Parameters
- \`admin\`: administrator

### pub fn \`status\` — line 12

Return the current status.
`;

test("generates deterministic contract pages from fixtures", () => {
  const pages = collectContractPages({ rootDir: fixtureRoot });
  assert.deepEqual([...pages.keys()], ["arena.md", "factory.md", "index.md"]);
  assert.equal(pages.get("arena.md"), expectedArena);
  assert.deepEqual(collectContractPages({ rootDir: fixtureRoot }), pages);
});

test("skips benchmark crates and indexes the rest", () => {
  const pages = collectContractPages({ rootDir: fixtureRoot });
  assert.match(pages.get("index.md"), /- \[arena\]\(\.\/arena\.md\)/);
  assert.match(pages.get("index.md"), /- \[factory\]\(\.\/factory\.md\)/);
  assert.doesNotMatch([...pages.values()].join("\n"), /cost-bench|Benchmark-only/);
});

test("parses doc comments before pub fn entries", () => {
  const entries = parseRustDocEntries("/// Documented.\npub fn documented() {}\n\nfn private() {}", "crate/src/lib.rs");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "documented");
  assert.equal(entries[0].kind, "pub fn");
  assert.match(entries[0].doc, /Documented\./);
});
