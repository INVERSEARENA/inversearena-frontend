import test from "node:test";
import assert from "node:assert/strict";
import { checkBody } from "./check-body.mjs";

const config = {
  enforceAfter: "2026-01-01T00:00:00Z",
  botAllowlist: ["dependabot[bot]"],
  dryRun: false,
};

test("requires linked issue and checked boxes", () => {
  const r = checkBody({ body: "## Summary\n- [ ] done", author: "alice", createdAt: "2026-02-01T00:00:00Z", config });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /linked issue/i);
  assert.match(r.errors.join("\n"), /unchecked/i);
});

test("passes when requirements met", () => {
  const r = checkBody({ body: "Closes #12\n- [x] done", author: "alice", createdAt: "2026-02-01T00:00:00Z", config });
  assert.equal(r.ok, true);
});

test("bot authors exempt", () => {
  const r = checkBody({ body: "no issue", author: "dependabot[bot]", createdAt: "2026-02-01T00:00:00Z", config });
  assert.equal(r.ok, true);
  assert.equal(r.bot, true);
});

test("enforceAfter honored", () => {
  const r = checkBody({ body: "no issue", author: "alice", createdAt: "2025-01-01T00:00:00Z", config });
  assert.equal(r.ok, true);
  assert.equal(r.enforced, false);
});
