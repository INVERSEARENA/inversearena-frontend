import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { generateSummaryMarkdown } from "../summarize-bundle.mjs";

describe("summarize-bundle", () => {
  it("generates markdown summary when manifest and assets exist", () => {
    const summary = generateSummaryMarkdown("non-existent-log.log", ".next");
    assert.match(summary, /## 📦 Frontend Bundle Size Summary/);
    assert.match(summary, /Production build compiled successfully/);
    assert.match(summary, /Client Chunks/);
    assert.match(summary, /Server Artifacts/);
    assert.match(summary, /Total Build Artifacts/);
    assert.match(summary, /Compiled Routes/);
  });

  it("handles missing next directory gracefully", () => {
    const summary = generateSummaryMarkdown("non-existent.log", "non-existent-dir");
    assert.match(summary, /## 📦 Frontend Bundle Size Summary/);
    assert.match(summary, /0 B/);
  });
});
