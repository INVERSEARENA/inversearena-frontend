import test from "node:test";
import assert from "node:assert/strict";
import { detectStale } from "./detect-stale.mjs";

const config = { botAllowlist: ["dependabot[bot]"], staleDays: 30 };

test("flags stale non-bot PRs", () => {
  const now = new Date("2026-05-01T00:00:00Z");
  const stale = detectStale([
    { number: 1, author: "a", updatedAt: "2026-03-01T00:00:00Z", url: "u1" },
    { number: 2, author: "b", updatedAt: "2026-04-20T00:00:00Z", url: "u2" },
  ], config, now);
  assert.deepEqual(stale.map(s => s.number), [1]);
});

test("excludes bots and draft/closed", () => {
  const now = new Date("2026-05-01T00:00:00Z");
  const stale = detectStale([
    { number: 1, author: "dependabot[bot]", updatedAt: "2026-01-01T00:00:00Z" },
    { number: 2, author: "a", updatedAt: "2026-01-01T00:00:00Z", draft: true },
    { number: 3, author: "a", updatedAt: "2026-01-01T00:00:00Z", closed: true },
  ], config, now);
  assert.equal(stale.length, 0);
});
