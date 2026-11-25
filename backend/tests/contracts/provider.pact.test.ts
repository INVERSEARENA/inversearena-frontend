import * as http from "node:http";
import * as path from "node:path";
import * as fs from "node:fs";
import express from "express";
import { verifyPactFile } from "../../../shared/pact/pactV4";

const PACT_FILE = path.resolve(
  __dirname,
  "../../../frontend/pacts/inversearena-frontend-inversearena-backend.json",
);

interface SeededState {
  leaderboard: Array<{
    id: string;
    rank: number;
    walletAddress: string;
    survivalStreak: number;
    totalYield: number;
    arenasWon: number;
  }>;
  arenas: Array<{
    id: string;
    name: string;
    status: string;
    entryFee: number;
    stakeToken: string;
    maxPlayers: number;
  }>;
  participants: Array<{
    id: string;
    walletAddress: string;
    choice: "heads" | "tails" | "option3" | null;
    stake: number;
    status: "READY" | "ACTIVE" | "ELIMINATED";
    roundNumber: number;
    joinedAt: string;
  }>;
  claims: Array<Record<string, unknown>>;
  breakLeaderboardContract: boolean;
}

function buildProviderApp(state: SeededState) {
  const app = express();
  app.use(express.json());

  app.get("/api/leaderboard", (_req, res) => {
    if (state.breakLeaderboardContract) {
      // Deliberate breaking change: omit nextCursor and rename walletAddress
      res.json({
        players: state.leaderboard.map((p) => ({
          id: p.id,
          rank: p.rank,
          address: p.walletAddress,
        })),
      });
      return;
    }
    res.json({ players: state.leaderboard, nextCursor: null });
  });

  app.get("/api/arenas", (_req, res) => {
    res.json({ arenas: state.arenas });
  });

  app.get("/api/arenas/:id/stats", (req, res) => {
    const arena = state.arenas.find((a) => a.id === req.params.id);
    if (!arena) {
      res.status(404).json({ error: "Arena not found" });
      return;
    }
    res.json({
      arenaId: arena.id,
      arenaName: arena.name,
      currentPot: 100,
      playerCount: 10,
      maxPlayers: arena.maxPlayers,
      survivorCount: 10,
      currentRound: 1,
      entryFee: arena.entryFee,
      stakeToken: arena.stakeToken,
      joinDeadline: "2026-12-01T00:00:00.000Z",
      yieldAccrued: 1.25,
      status: arena.status,
      lastUpdated: "2026-11-24T12:00:00.000Z",
    });
  });

  app.get("/api/arenas/:id/participants", (req, res) => {
    res.json({
      arenaId: req.params.id,
      total: state.participants.length,
      nextCursor: null,
      hasMore: false,
      items: state.participants,
    });
  });

  app.get("/api/users/me/claim-inbox", (_req, res) => {
    res.json({
      items: state.claims,
      summary: {
        actionableCount: state.claims.length,
        pendingCount: 0,
        completedCount: 0,
        blockedCount: 0,
        unavailableCount: 0,
      },
      cursor: null,
      hasMore: false,
      verificationComplete: true,
    });
  });

  app.post("/api/auth/nonce", (_req, res) => {
    res.json({
      nonce: "nonce-hex-123456",
      message: "Sign this nonce to authenticate: nonce-hex-123456",
      expiresAt: "2026-11-24T12:05:00.000Z",
    });
  });

  app.post("/api/auth/verify", (req, res) => {
    res.json({
      accessToken: "jwt-access-token",
      walletAddress: req.body.walletAddress,
    });
  });

  return app;
}

describe("Backend Pact Provider Verification (#1846)", () => {
  const state: SeededState = {
    leaderboard: [],
    arenas: [],
    participants: [],
    claims: [],
    breakLeaderboardContract: false,
  };

  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = buildProviderApp(state);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  const stateHandlers = {
    "leaderboard has ranked players": () => {
      state.leaderboard = [
        {
          id: "player-1",
          rank: 1,
          walletAddress: "GABC1234567890TESTWALLET",
          survivalStreak: 5,
          totalYield: 120.5,
          arenasWon: 3,
        },
      ];
    },
    "arenas exist in the lobby": () => {
      state.arenas = [
        {
          id: "arena-1",
          name: "High Stakes Minority",
          status: "OPEN",
          entryFee: 10,
          stakeToken: "USDC",
          maxPlayers: 32,
        },
      ];
    },
    "arena exists with id arena-1": (params?: Record<string, unknown>) => {
      const id = String(params?.arenaId ?? "arena-1");
      state.arenas = [
        {
          id,
          name: "High Stakes Minority",
          status: "OPEN",
          entryFee: 10,
          stakeToken: "USDC",
          maxPlayers: 32,
        },
      ];
    },
    "arena arena-1 has active participants": () => {
      state.participants = [
        {
          id: "part-1",
          walletAddress: "GABC1234567890TESTWALLET",
          choice: "heads",
          stake: 10,
          status: "ACTIVE",
          roundNumber: 1,
          joinedAt: "2026-11-24T12:00:00.000Z",
        },
      ];
    },
    "authenticated user has a claimable payout": () => {
      state.claims = [
        {
          arenaId: "arena-1",
          arenaName: "High Stakes Minority",
          kind: "winner_claim",
          state: "actionable",
          reason: "claim_ready",
          amountStroops: "150000000",
          assetCode: "USDC",
          message: "Your prize is ready to claim.",
          updatedAt: "2026-11-24T12:00:00.000Z",
          action: { kind: "claim", label: "Claim Prize" },
        },
      ];
    },
    "auth service is ready to issue nonces": () => {},
    "a valid auth nonce exists for wallet": () => {},
  };

  it("verifies all frontend consumer Pact interactions against backend routes", async () => {
    if (!fs.existsSync(PACT_FILE)) {
      throw new Error(`Pact file missing at ${PACT_FILE}. Run frontend pact consumer tests first.`);
    }
    state.breakLeaderboardContract = false;
    await expect(
      verifyPactFile({
        pactFilePath: PACT_FILE,
        baseUrl,
        stateHandlers,
      }),
    ).resolves.toBeUndefined();
  });

  it("fails provider verification when a breaking API change drops or renames required fields", async () => {
    state.breakLeaderboardContract = true;
    await expect(
      verifyPactFile({
        pactFilePath: PACT_FILE,
        baseUrl,
        stateHandlers,
      }),
    ).rejects.toThrow(/missing required contract field/);
    state.breakLeaderboardContract = false;
  });
});
