import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import request from "supertest";
import { errorHandler } from "../../src/middleware/errorHandler";
import { HttpError } from "../../src/utils/apiError";

test("Express 5 natively forwards rejected promises from async handlers to errorHandler", async () => {
  const app = express();

  // Route without any try/catch or asyncHandler wrapper
  app.get("/async-throw", async () => {
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "Arena was not found");
  });

  app.use(errorHandler);

  const res = await request(app).get("/async-throw");
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, "RESOURCE_NOT_FOUND");
  assert.equal(res.body.error.message, "Arena was not found");
});

test("Express 5 natively catches unhandled promise rejections in handlers with 500 status", async () => {
  const app = express();

  app.get("/async-reject", async () => {
    // Standard Error should result in 500 Internal server error
    throw new Error("Database connection lost");
  });

  app.use(errorHandler);

  const res = await request(app).get("/async-reject");
  assert.equal(res.status, 500);
  assert.equal(res.body.error.code, "INTERNAL_ERROR");
  assert.equal(res.body.error.message, "Internal server error");
});
