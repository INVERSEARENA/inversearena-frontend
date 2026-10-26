import express from "express";
import request from "supertest";

import {
  buildPublicCacheControl,
  privateNoStore,
  publicCache,
  requestIsPersonalized,
} from "../cachePolicy";

function appWith(...handlers: express.RequestHandler[]): express.Express {
  const app = express();
  for (const handler of handlers) app.use(handler);
  app.get("/public", publicCache({ maxAge: 30, staleWhileRevalidate: 300 }), (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/private", privateNoStore(), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe("cachePolicy (#1626)", () => {
  describe("buildPublicCacheControl", () => {
    it("emits public, max-age, must-revalidate and stale-while-revalidate", () => {
      expect(buildPublicCacheControl({ maxAge: 30, staleWhileRevalidate: 300 })).toBe(
        "public, max-age=30, must-revalidate, stale-while-revalidate=300",
      );
    });

    it("includes stale-if-error when provided", () => {
      expect(
        buildPublicCacheControl({ maxAge: 10, staleWhileRevalidate: 60, staleIfError: 600 }),
      ).toBe("public, max-age=10, must-revalidate, stale-while-revalidate=60, stale-if-error=600");
    });
  });

  describe("requestIsPersonalized", () => {
    const req = (headers: Record<string, string>) =>
      ({ headers } as unknown as express.Request);

    it("is false for an anonymous request", () => {
      expect(requestIsPersonalized(req({}))).toBe(false);
    });

    it("is true when an Authorization header is present", () => {
      expect(requestIsPersonalized(req({ authorization: "Bearer x" }))).toBe(true);
    });

    it("is true when a cookie is present", () => {
      expect(requestIsPersonalized(req({ cookie: "session=abc" }))).toBe(true);
    });
  });

  describe("publicCache", () => {
    it("sets a shared Cache-Control for an anonymous request", async () => {
      const res = await request(appWith()).get("/public");
      expect(res.headers["cache-control"]).toBe(
        "public, max-age=30, must-revalidate, stale-while-revalidate=300",
      );
    });

    it("never emits a shared directive for an authenticated request", async () => {
      const res = await request(appWith())
        .get("/public")
        .set("Authorization", "Bearer secret-token");
      expect(res.headers["cache-control"]).toBeUndefined();
    });

    it("never emits a shared directive when a cookie is sent", async () => {
      const res = await request(appWith()).get("/public").set("Cookie", "session=abc");
      expect(res.headers["cache-control"]).toBeUndefined();
    });
  });

  describe("privateNoStore", () => {
    it("defaults un-opted responses to no-store", async () => {
      const res = await request(appWith(privateNoStore())).get("/private");
      expect(res.headers["cache-control"]).toBe("no-store");
    });

    it("does not overwrite a Cache-Control another handler already set", async () => {
      const app = express();
      app.use(privateNoStore());
      app.get("/x", (_req, res) => {
        res.setHeader("Cache-Control", "public, max-age=5");
        res.json({ ok: true });
      });
      const res = await request(app).get("/x");
      expect(res.headers["cache-control"]).toBe("public, max-age=5");
    });
  });
});
