import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertNavIntegrity, buildNav, collectMarkdownSources, slugForSource } from "./sources.mjs";

const portalDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(portalDir, "..");

test("slugs include an area prefix and keep duplicate filenames distinct", () => {
  const slugs = [
    slugForSource("root", "README.md"),
    slugForSource("docs", "README.md"),
    slugForSource("contract", "README.md"),
    slugForSource("docs", "architecture/incremental-reliability.md"),
  ];

  assert.deepEqual(slugs, [
    "root-readme",
    "docs-readme",
    "contract-readme",
    "docs-architecture-incremental-reliability",
  ]);
  assert.equal(new Set(slugs).size, slugs.length);
});

test("nav covers every source with unique slugs", () => {
  const sources = collectMarkdownSources(repoRoot);
  const nav = buildNav(sources);
  assert.equal(assertNavIntegrity(sources, nav), true);
  assert.equal(nav.flatMap((section) => section.items).length, sources.length);
});

test("duplicate slugs are rejected", () => {
  const sources = [
    { area: "docs", slug: "docs-a", title: "A", sourcePath: "docs/a.md" },
    { area: "docs", slug: "docs-a", title: "A again", sourcePath: "docs/a-again.md" },
  ];
  assert.throws(() => assertNavIntegrity(sources, buildNav(sources)), /Duplicate documentation slugs/);
});

test("orphan nav entries are rejected", () => {
  const sources = [{ area: "docs", slug: "docs-a", title: "A", sourcePath: "docs/a.md" }];
  const nav = buildNav(sources);
  nav[0].items.push({ slug: "docs-orphan", title: "Orphan", sourcePath: "docs/orphan.md" });
  assert.throws(() => assertNavIntegrity(sources, nav), /Navigation coverage failed/);
});
