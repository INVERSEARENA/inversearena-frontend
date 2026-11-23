import assert from "node:assert/strict";
import test from "node:test";
import { assertOpenApiDocument, validateOpenApiDocument } from "./generate-openapi.mjs";

const valid = {
  openapi: "3.1.0",
  paths: {
    "/health": { get: { responses: { 200: { description: "ok" } } } },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
  },
};

test("accepts an openapi 3.1 document with paths and bearerAuth", () => {
  assert.deepEqual(validateOpenApiDocument(valid), []);
  assert.equal(assertOpenApiDocument(valid), valid);
});

test("rejects wrong version, empty paths, and missing bearerAuth", () => {
  const problems = validateOpenApiDocument({ openapi: "3.0.3", paths: {} });
  assert.ok(problems.includes("openapi must be 3.1.x"));
  assert.ok(problems.includes("paths must contain at least one entry"));
  assert.ok(problems.includes("components.securitySchemes.bearerAuth must exist"));
});

test("asserts invalid documents", () => {
  assert.throws(() => assertOpenApiDocument(null), /Invalid OpenAPI document/);
});
