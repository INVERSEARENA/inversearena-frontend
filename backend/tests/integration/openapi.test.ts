import request from "supertest";
import { setupTestApp } from "./testApp";
import { clearOpenApiCache } from "../../src/routes/docs";

describe("OpenAPI documentation", () => {
  const app = setupTestApp();

  beforeEach(() => {
    clearOpenApiCache();
  });

  it("GET /api/docs.json returns OpenAPI 3.1 document", async () => {
    const res = await request(app).get("/api/docs.json");

    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\.1\./);
    expect(res.body.paths["/api/auth/verify"]).toBeDefined();
    expect(res.body.paths["/api/auth/nonce"]).toBeDefined();
    expect(res.body.paths["/api/leaderboard"]).toBeDefined();
    expect(res.body.paths["/api/admin/rounds/resolve"]).toBeDefined();
    expect(res.body.components?.securitySchemes?.bearerAuth).toBeDefined();
  });

  it("GET /api/docs serves Swagger UI", async () => {
    const res = await request(app).get("/api/docs/");

    expect(res.status).toBe(200);
    expect(res.text).toContain("swagger");
  });
});
