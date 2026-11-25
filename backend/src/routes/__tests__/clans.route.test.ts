import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { Express } from "express";
import { createClansRouter } from "../clans";
import * as express from "express";

vi.mock("../../services/clanService");

describe("Clans Routes", () => {
  let app: Express;

  beforeEach(() => {
    app = express.default();
    app.use(express.json());

    const mockAuth = (req: any, res: any, next: any) => {
      req.wallet = "0x123";
      next();
    };

    app.use("/clans", createClansRouter(mockAuth));
  });

  it("POST /clans should create a new clan", async () => {
    const response = await request(app).post("/clans").send({
      name: "Elite Squad",
      tag: "ELIT",
      description: "Top players",
    });

    expect(response.status).toBe(201);
  });

  it("GET /clans/leaderboard should return clan leaderboard", async () => {
    const response = await request(app).get("/clans/leaderboard?limit=20");
    expect(response.status).toBe(200);
  });
});
