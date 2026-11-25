import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { Express } from "express";
import { createJackpotsRouter } from "../jackpots";
import * as express from "express";

vi.mock("../../services/jackpotService");

describe("Jackpots Routes", () => {
  let app: Express;

  beforeEach(() => {
    app = express.default();
    app.use(express.json());

    const mockAuth = (req: any, res: any, next: any) => {
      req.wallet = "0x123";
      next();
    };

    app.use("/jackpots", createJackpotsRouter(mockAuth));
  });

  it("GET /jackpots/:stakeToken should return jackpot data", async () => {
    const response = await request(app).get("/jackpots/USDC");
    expect(response.status).toBe(200);
  });

  it("GET /jackpots/:stakeToken/history should return award history", async () => {
    const response = await request(app).get("/jackpots/USDC/history?limit=10");
    expect(response.status).toBe(200);
  });
});
