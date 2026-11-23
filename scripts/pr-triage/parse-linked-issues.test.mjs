import test from "node:test";
import assert from "node:assert/strict";
import { parseLinkedIssues } from "./parse-linked-issues.mjs";

test("parses same-repo close keywords", () => {
  assert.deepEqual(parseLinkedIssues("Closes #123"), ["#123"]);
  assert.deepEqual(parseLinkedIssues("fixes #1 and resolves #2"), ["#1", "#2"]);
});

test("parses cross-repo and URLs", () => {
  const body = "Fixes owner/repo#9 and https://github.com/a/b/issues/10";
  assert.deepEqual(parseLinkedIssues(body), ["a/b#10", "owner/repo#9"]);
});

test("ignores fenced code and HTML comments", () => {
  const body = "<!-- Closes #1 -->\n```\nFixes #2\n```\nResolves #3";
  assert.deepEqual(parseLinkedIssues(body), ["#3"]);
});

test("handles CRLF", () => {
  assert.deepEqual(parseLinkedIssues("Fixes #7\r\n\r\nMore"), ["#7"]);
});
