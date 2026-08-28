import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";

const get = jest.fn(async () => null as unknown as string | null);
const set = jest.fn(async () => "OK");
jest.mock("../src/cache/redisClient", () => ({
  redis: {
    get,
    set,
    del: jest.fn(async () => 1),
  },
}));

import { cacheMiddleware } from "../src/middleware/cache";

describe("cacheMiddleware (#1213)", () => {
  beforeEach(() => {
    get.mockClear();
    set.mockClear();
  });

  function buildApp(handler: express.RequestHandler) {
    const app = express();
    app.get("/thing", cacheMiddleware(() => "cache-key", 60), handler);
    return app;
  }

  it("does not cache a 4xx response", async () => {
    const app = buildApp((_req, res) => {
      res.status(404).json({ error: "not found" });
    });

    const response = await request(app).get("/thing");

    expect(response.status).toBe(404);
    // cache.set is fired without awaiting inside the middleware — flush
    // the microtask queue so the (absent) call would have landed by now.
    await new Promise((resolve) => setImmediate(resolve));
    expect(set).not.toHaveBeenCalled();
  });

  it("does not cache a 5xx response", async () => {
    const app = buildApp((_req, res) => {
      res.status(500).json({ error: "internal error" });
    });

    const response = await request(app).get("/thing");

    expect(response.status).toBe(500);
    await new Promise((resolve) => setImmediate(resolve));
    expect(set).not.toHaveBeenCalled();
  });

  it("still caches a successful response", async () => {
    const app = buildApp((_req, res) => {
      res.status(200).json({ ok: true });
    });

    const response = await request(app).get("/thing");

    expect(response.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(set).toHaveBeenCalledWith("cache-key", JSON.stringify({ ok: true }), "EX", 60);
  });

  it("caches a 201/2xx response, not just exactly 200", async () => {
    const app = buildApp((_req, res) => {
      res.status(201).json({ created: true });
    });

    const response = await request(app).get("/thing");

    expect(response.status).toBe(201);
    await new Promise((resolve) => setImmediate(resolve));
    expect(set).toHaveBeenCalledWith("cache-key", JSON.stringify({ created: true }), "EX", 60);
  });
});
