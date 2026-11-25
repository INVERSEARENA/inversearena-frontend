import * as path from "node:path";
import { z } from "zod";
import { PactV4Consumer, getMockResponseFromPact } from "../../../../shared/pact/pactV4";
import { claimInboxPageSchema } from "@/features/claim-inbox/model/types";

const PACT_DIR = path.resolve(__dirname, "../../../pacts");

const leaderboardResponseSchema = z.object({
  players: z.array(
    z.object({
      id: z.string(),
      rank: z.number(),
      walletAddress: z.string(),
      survivalStreak: z.number(),
      totalYield: z.number(),
      arenasWon: z.number(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

const arenaListResponseSchema = z.object({
  arenas: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      status: z.string(),
      entryFee: z.number(),
      stakeToken: z.string(),
      maxPlayers: z.number(),
    }),
  ),
});

const arenaDetailStatsSchema = z.object({
  arenaId: z.string(),
  arenaName: z.string(),
  currentPot: z.number(),
  playerCount: z.number(),
  maxPlayers: z.number(),
  survivorCount: z.number(),
  currentRound: z.number(),
  entryFee: z.number(),
  stakeToken: z.string(),
  joinDeadline: z.string().nullable(),
  yieldAccrued: z.number(),
  status: z.string(),
  lastUpdated: z.string(),
});

const playerStatusParticipantsSchema = z.object({
  arenaId: z.string(),
  total: z.number(),
  nextCursor: z.number().nullable(),
  hasMore: z.boolean(),
  items: z.array(
    z.object({
      id: z.string(),
      walletAddress: z.string(),
      choice: z.enum(["heads", "tails", "option3"]).nullable(),
      stake: z.number(),
      status: z.enum(["READY", "ACTIVE", "ELIMINATED"]),
      roundNumber: z.number(),
      joinedAt: z.string(),
    }),
  ),
});

const authNonceResponseSchema = z.object({
  nonce: z.string(),
  message: z.string(),
  expiresAt: z.string(),
});

const authVerifyResponseSchema = z.object({
  accessToken: z.string(),
  walletAddress: z.string(),
});

describe("Frontend API Consumer Pact Contracts (#1846)", () => {
  it("generates and validates Pact v4 contracts for leaderboard, arenas, player status, claims, and auth", async () => {
    const pact = new PactV4Consumer(
      "inversearena-frontend",
      "inversearena-backend",
      PACT_DIR,
    );

    // 1. Leaderboard
    pact.addInteraction({
      description: "a request for the global leaderboard",
      providerStates: [{ name: "leaderboard has ranked players" }],
      request: {
        method: "GET",
        path: "/api/leaderboard",
        query: { limit: "20" },
        headers: { Authorization: "Bearer test-jwt" },
      },
      response: {
        status: 200,
        body: {
          players: [
            {
              id: "player-1",
              rank: 1,
              walletAddress: "GABC1234567890TESTWALLET",
              survivalStreak: 5,
              totalYield: 120.5,
              arenasWon: 3,
            },
          ],
          nextCursor: null,
        },
      },
    });

    // 2. Arena List
    pact.addInteraction({
      description: "a request for the arena list",
      providerStates: [{ name: "arenas exist in the lobby" }],
      request: {
        method: "GET",
        path: "/api/arenas",
      },
      response: {
        status: 200,
        body: {
          arenas: [
            {
              id: "arena-1",
              name: "High Stakes Minority",
              status: "OPEN",
              entryFee: 10,
              stakeToken: "USDC",
              maxPlayers: 32,
            },
          ],
        },
      },
    });

    // 3. Arena Detail
    pact.addInteraction({
      description: "a request for arena detail stats",
      providerStates: [{ name: "arena exists with id arena-1", params: { arenaId: "arena-1" } }],
      request: {
        method: "GET",
        path: "/api/arenas/arena-1/stats",
      },
      response: {
        status: 200,
        body: {
          arenaId: "arena-1",
          arenaName: "High Stakes Minority",
          currentPot: 100,
          playerCount: 10,
          maxPlayers: 32,
          survivorCount: 10,
          currentRound: 1,
          entryFee: 10,
          stakeToken: "USDC",
          joinDeadline: "2026-12-01T00:00:00.000Z",
          yieldAccrued: 1.25,
          status: "OPEN",
          lastUpdated: "2026-11-24T12:00:00.000Z",
        },
      },
    });

    // 4. Player Status (participants list)
    pact.addInteraction({
      description: "a request for arena participant player status",
      providerStates: [{ name: "arena arena-1 has active participants", params: { arenaId: "arena-1" } }],
      request: {
        method: "GET",
        path: "/api/arenas/arena-1/participants",
        query: { limit: "25", cursor: "0" },
      },
      response: {
        status: 200,
        body: {
          arenaId: "arena-1",
          total: 1,
          nextCursor: null,
          hasMore: false,
          items: [
            {
              id: "part-1",
              walletAddress: "GABC1234567890TESTWALLET",
              choice: "heads",
              stake: 10,
              status: "ACTIVE",
              roundNumber: 1,
              joinedAt: "2026-11-24T12:00:00.000Z",
            },
          ],
        },
      },
    });

    // 5. Claims Inbox
    pact.addInteraction({
      description: "a request for the user claim inbox",
      providerStates: [{ name: "authenticated user has a claimable payout" }],
      request: {
        method: "GET",
        path: "/api/users/me/claim-inbox",
        query: { limit: "20" },
        headers: { Authorization: "Bearer test-jwt" },
      },
      response: {
        status: 200,
        body: {
          items: [
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
              action: {
                kind: "claim",
                label: "Claim Prize",
              },
            },
          ],
          summary: {
            actionableCount: 1,
            pendingCount: 0,
            completedCount: 0,
            blockedCount: 0,
            unavailableCount: 0,
          },
          cursor: null,
          hasMore: false,
          verificationComplete: true,
        },
      },
    });

    // 6a. Auth Nonce
    pact.addInteraction({
      description: "a request for a wallet auth nonce",
      providerStates: [{ name: "auth service is ready to issue nonces" }],
      request: {
        method: "POST",
        path: "/api/auth/nonce",
        body: { walletAddress: "GABC1234567890TESTWALLET" },
      },
      response: {
        status: 200,
        body: {
          nonce: "nonce-hex-123456",
          message: "Sign this nonce to authenticate: nonce-hex-123456",
          expiresAt: "2026-11-24T12:05:00.000Z",
        },
      },
    });

    // 6b. Auth Verify (Login)
    pact.addInteraction({
      description: "a request to verify wallet signature and login",
      providerStates: [{ name: "a valid auth nonce exists for wallet" }],
      request: {
        method: "POST",
        path: "/api/auth/verify",
        body: {
          walletAddress: "GABC1234567890TESTWALLET",
          signature: "valid-signature-base64",
          nonce: "nonce-hex-123456",
        },
      },
      response: {
        status: 200,
        body: {
          accessToken: "jwt-access-token",
          walletAddress: "GABC1234567890TESTWALLET",
        },
      },
    });

    const pactPath = await pact.executeTest(async (baseUrl) => {
      // 1. Leaderboard
      const lbRes = await fetch(`${baseUrl}/api/leaderboard?limit=20`, {
        headers: { Authorization: "Bearer test-jwt" },
      });
      expect(lbRes.status).toBe(200);
      leaderboardResponseSchema.parse(await lbRes.json());

      // 2. Arena List
      const listRes = await fetch(`${baseUrl}/api/arenas`);
      expect(listRes.status).toBe(200);
      arenaListResponseSchema.parse(await listRes.json());

      // 3. Arena Detail
      const detailRes = await fetch(`${baseUrl}/api/arenas/arena-1/stats`);
      expect(detailRes.status).toBe(200);
      arenaDetailStatsSchema.parse(await detailRes.json());

      // 4. Player Status
      const partRes = await fetch(`${baseUrl}/api/arenas/arena-1/participants?limit=25&cursor=0`);
      expect(partRes.status).toBe(200);
      playerStatusParticipantsSchema.parse(await partRes.json());

      // 5. Claim Inbox
      const claimRes = await fetch(`${baseUrl}/api/users/me/claim-inbox?limit=20`, {
        headers: { Authorization: "Bearer test-jwt" },
      });
      expect(claimRes.status).toBe(200);
      claimInboxPageSchema.parse(await claimRes.json());

      // 6a. Auth Nonce
      const nonceRes = await fetch(`${baseUrl}/api/auth/nonce`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: "GABC1234567890TESTWALLET" }),
      });
      expect(nonceRes.status).toBe(200);
      authNonceResponseSchema.parse(await nonceRes.json());

      // 6b. Auth Verify
      const verifyRes = await fetch(`${baseUrl}/api/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: "GABC1234567890TESTWALLET",
          signature: "valid-signature-base64",
          nonce: "nonce-hex-123456",
        }),
      });
      expect(verifyRes.status).toBe(200);
      authVerifyResponseSchema.parse(await verifyRes.json());
    });

    // Verify frontend hook mocks can be extracted directly from the generated Pact file
    const lbMock = getMockResponseFromPact(pactPath, "a request for the global leaderboard");
    expect(() => leaderboardResponseSchema.parse(lbMock)).not.toThrow();
  });
});
