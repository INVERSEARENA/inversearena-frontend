import test from "node:test";
import assert from "node:assert/strict";
import { renderBodyComment, renderDuplicateComment, renderStaleComment } from "./render-comments.mjs";

test("body comment includes marker and escapes content", () => {
  const body = renderBodyComment({ ok: false, errors: ["bad <script>`x`"] });
  assert.match(body, /<!-- pr-triage:body -->/);
  assert.match(body, /&lt;script&gt;&#96;x&#96;/);
});

test("duplicate comment is idempotent marker per issue key", () => {
  const body = renderDuplicateComment({ issueKey: "#10", prs: [{ number: 1, author: "a", url: "u" }] });
  assert.match(body, /<!-- pr-triage:duplicate:#10 -->/);
  assert.match(body, /advisory only/i);
});

test("stale comment mentions maintainers and threshold", () => {
  const body = renderStaleComment({ number: 2, ageDays: 31 }, { staleDays: 30 });
  assert.match(body, /<!-- pr-triage:stale -->/);
  assert.match(body, /@INVERSEARENA\/maintainers/);
  assert.match(body, /30 days/);
});
