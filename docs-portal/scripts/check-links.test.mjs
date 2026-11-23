import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkMarkdownLinks, collectMarkdownLinks, collectLinkSources } from "./check-links.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/links");
const sources = collectLinkSources(rootDir);
const source = (name) => sources.find((entry) => entry.sourcePath === `docs/${name}`);
const only = (...names) => names.map(source);

test("valid relative links, anchors, and external links pass", () => {
  const problems = checkMarkdownLinks({ rootDir, sources: only("valid.md", "target.md"), allowlist: [] });
  assert.deepEqual(problems, []);
});

test("missing targets are reported", () => {
  const problems = checkMarkdownLinks({ rootDir, sources: only("missing.md"), allowlist: [] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /missing target \.\/missing-target\.md/);
});

test("bad anchors are reported", () => {
  const problems = checkMarkdownLinks({ rootDir, sources: only("bad-anchor.md", "target.md"), allowlist: [] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unknown anchor/);
});

test("external links are skipped", () => {
  const links = collectMarkdownLinks(readFileSync(resolve(rootDir, "docs/valid.md"), "utf8"));
  assert.ok(links.some((link) => link.href === "https://example.com/docs"));
  assert.ok(links.some((link) => link.href === "mailto:docs@example.com"));
});

test("fenced code and html comments are ignored", () => {
  const problems = checkMarkdownLinks({ rootDir, sources: only("fenced.md"), allowlist: [] });
  assert.deepEqual(problems, []);
});

test("allowlisted links are skipped", () => {
  const problems = checkMarkdownLinks({
    rootDir,
    sources: only("missing.md"),
    allowlist: [{ source: "docs/missing.md", target: "./missing-target.md", reason: "fixture" }],
  });
  assert.deepEqual(problems, []);
});
