import express from "express";
import request from "supertest";
import { createWalletRoleRouter } from "../src/routes/walletRole";
import { errorHandler } from "../src/middleware/errorHandler";

const VALID_ADDRESS = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

function buildApp() {
  const app = express();
  app.use("/api/admin", createWalletRoleRouter());
  app.use(errorHandler);
  return app;
}

describe("GET /api/admin/wallet-role", () => {
  const originalEnv = process.env.ADMIN_WALLET_ADDRESSES;
  const app = buildApp();

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ADMIN_WALLET_ADDRESSES;
    } else {
      process.env.ADMIN_WALLET_ADDRESSES = originalEnv;
    }
  });

  it("returns isAdmin: false for a connected wallet that is not on the allowlist", async () => {
    delete process.env.ADMIN_WALLET_ADDRESSES;

    const res = await request(app)
      .get("/api/admin/wallet-role")
      .query({ address: VALID_ADDRESS });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ address: VALID_ADDRESS, isAdmin: false });
  });

  it("returns isAdmin: true for an allowlisted wallet", async () => {
    process.env.ADMIN_WALLET_ADDRESSES = VALID_ADDRESS;

    const res = await request(app)
      .get("/api/admin/wallet-role")
      .query({ address: VALID_ADDRESS });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ address: VALID_ADDRESS, isAdmin: true });
  });

  it("rejects a malformed address with 400", async () => {
    process.env.ADMIN_WALLET_ADDRESSES = VALID_ADDRESS;

    const res = await request(app)
      .get("/api/admin/wallet-role")
      .query({ address: "<script>alert(1)</script>" });

    expect(res.status).toBe(400);
  });

  it("requires an address query param", async () => {
    const res = await request(app).get("/api/admin/wallet-role");

    expect(res.status).toBe(400);
  });
});
