import test from "node:test";
import assert from "node:assert/strict";
import { detectDuplicates } from "./detect-duplicates.mjs";

const config = { botAllowlist: ["dependabot[bot]"] };

test("groups PRs by linked issue", () => {
  const groups = detectDuplicates([
    { number: 1, author: "a", body: "Closes #10" },
    { number: 2, author: "b", body: "Fixes #10" },
    { number: 3, author: "c", body: "Fixes #11" },
  ], config);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].issueKey, "#10");
  assert.deepEqual(groups[0].prs.map(p => p.number), [1, 2]);
});

test("excludes self, bots, draft/closed", () => {
  const groups = detectDuplicates([
    { number: 1, author: "a", body: "Closes #10" },
    { number: 2, author: "dependabot[bot]", body: "Closes #10" },
    { number: 3, author: "b", body: "Closes #10", closed: true },
    { number: 4, author: "c", body: "Closes #10", draft: true },
  ], config);
  assert.equal(groups.length, 0);
});
