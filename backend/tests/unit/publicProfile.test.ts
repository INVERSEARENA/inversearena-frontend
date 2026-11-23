import {
  getPublicUserProfile,
  getUserPrivacySettings,
  updateUserPrivacySettings,
  ProfileNotFoundError,
} from "../../src/services/userProfileService";
import { UserModel } from "../../src/db/models/user.model";

jest.mock("../../src/db/models/user.model");

describe("Public Player Profile Service (#1742)", () => {
  let mockPrisma: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          gamesPlayed: "15",
          gamesWon: "8",
          totalYield: "450.50",
          rank: "4",
        },
      ]),
      arena: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "arena-abc-123",
            status: "SETTLED",
            metadata: { name: "Apex Alpha" },
            updatedAt: new Date("2026-06-01T12:00:00Z"),
            rounds: [{ state: "SETTLED" }],
          },
        ]),
      },
    };
  });

  describe("Public Profile Resolution & Field Filtering", () => {
    it("resolves active alias and returns public-only fields", async () => {
      (UserModel.findOne as jest.Mock).mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: "mongo-user-1",
          walletAddress: "GBEXAMPLE7VK45Z27EXAMPLE7VK45Z27EXAMPLE7VK45Z27EXAMPL",
          displayName: "cyber_ninja",
          joinedAt: new Date("2026-01-01T00:00:00Z"),
          aliasHistory: [{ alias: "cyber_ninja", setAt: "2026-01-01T00:00:00Z", retiredAt: null }],
          privacySettings: { hideHistory: false, hideFromSearch: false },
        }),
      });

      const profile = await getPublicUserProfile(mockPrisma, "cyber_ninja");

      expect(profile).toEqual(
        expect.objectContaining({
          address: "GBEXAMPLE7VK45Z27EXAMPLE7VK45Z27EXAMPLE7VK45Z27EXAMPL",
          alias: "cyber_ninja",
          level: expect.any(Number),
          stats: {
            gamesPlayed: 15,
            gamesWon: 8,
            totalYieldEarned: "450.50",
            currentRank: 4,
            winRate: 53,
          },
          privacy: {
            hideHistory: false,
            hideFromSearch: false,
          },
        }),
      );
      // Ensure internal sensitive fields are NOT present
      expect((profile as any)._id).toBeUndefined();
      expect((profile as any).lastLoginAt).toBeUndefined();
      expect((profile as any).session).toBeUndefined();
      expect(profile.recentSettledArenas.length).toBeGreaterThan(0);
      expect(profile.achievements.length).toBeGreaterThan(0);
    });

    it("respects privacy setting hideHistory by omitting settled arenas", async () => {
      (UserModel.findOne as jest.Mock).mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: "mongo-user-2",
          walletAddress: "GBEXAMPLE7VK45Z27EXAMPLE7VK45Z27EXAMPLE7VK45Z27EXAMPL",
          displayName: "private_player",
          joinedAt: new Date("2026-01-01T00:00:00Z"),
          aliasHistory: [{ alias: "private_player", setAt: "2026-01-01T00:00:00Z", retiredAt: null }],
          privacySettings: { hideHistory: true, hideFromSearch: false },
        }),
      });

      const profile = await getPublicUserProfile(mockPrisma, "private_player");

      expect(profile.privacy.hideHistory).toBe(true);
      expect(profile.recentSettledArenas).toEqual([]);
      expect(mockPrisma.arena.findMany).not.toHaveBeenCalled();
    });

    it("handles unknown address by returning on-chain-only baseline profile", async () => {
      (UserModel.findOne as jest.Mock).mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      });

      const address = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
      const profile = await getPublicUserProfile(mockPrisma, address);

      expect(profile).toEqual(
        expect.objectContaining({
          address,
          alias: null,
          isUnknown: true,
          level: 1,
          stats: {
            gamesPlayed: 0,
            gamesWon: 0,
            totalYieldEarned: "0.00",
            currentRank: null,
            winRate: 0,
          },
          achievements: [],
          recentSettledArenas: [],
        }),
      );
    });

    it("handles alias rotation and sets redirect for retired aliases in grace period", async () => {
      // 1. Not active
      (UserModel.findOne as jest.Mock)
        .mockReturnValueOnce({
          lean: jest.fn().mockResolvedValue(null),
        })
        // 2. Retired alias match
        .mockReturnValueOnce({
          lean: jest.fn().mockResolvedValue({
            _id: "mongo-user-3",
            walletAddress: "GBEXAMPLE7VK45Z27EXAMPLE7VK45Z27EXAMPLE7VK45Z27EXAMPL",
            displayName: "new_alias",
            joinedAt: new Date("2026-01-01T00:00:00Z"),
            aliasHistory: [
              { alias: "old_alias", setAt: "2026-01-01T00:00:00Z", retiredAt: new Date().toISOString() },
              { alias: "new_alias", setAt: new Date().toISOString(), retiredAt: null },
            ],
            privacySettings: { hideHistory: false, hideFromSearch: false },
          }),
        });

      const profile = await getPublicUserProfile(mockPrisma, "old_alias");

      expect(profile.redirect).toBe(true);
      expect(profile.canonicalAlias).toBe("new_alias");
    });

    it("handles banned/moderated players with suspended status", async () => {
      (UserModel.findOne as jest.Mock).mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: "mongo-user-banned",
          walletAddress: "GBEXAMPLE7VK45Z27EXAMPLE7VK45Z27EXAMPLE7VK45Z27EXAMPL",
          displayName: "banned_bad_actor",
          joinedAt: new Date("2026-01-01T00:00:00Z"),
          isBanned: true,
        }),
      });

      const profile = await getPublicUserProfile(mockPrisma, "banned_bad_actor");

      expect(profile.isBanned).toBe(true);
      expect(profile.recentSettledArenas).toEqual([]);
      expect(profile.stats.gamesPlayed).toBe(0);
    });

    it("throws ProfileNotFoundError for non-existent alias", async () => {
      (UserModel.findOne as jest.Mock).mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      });

      await expect(getPublicUserProfile(mockPrisma, "non_existent_alias")).rejects.toThrow(
        ProfileNotFoundError,
      );
    });
  });

  describe("Privacy Settings Updates", () => {
    it("reads and updates user privacy settings", async () => {
      const mockUserDoc = {
        _id: "user-123",
        privacySettings: { hideHistory: false, hideFromSearch: false },
        save: jest.fn().mockResolvedValue(true),
      };

      (UserModel.findById as jest.Mock).mockReturnValueOnce({
        lean: jest.fn().mockResolvedValue({
          _id: "user-123",
          privacySettings: { hideHistory: false, hideFromSearch: false },
        }),
      });

      const current = await getUserPrivacySettings("user-123");
      expect(current).toEqual({ hideHistory: false, hideFromSearch: false });

      (UserModel.findById as jest.Mock).mockResolvedValueOnce(mockUserDoc);

      const updated = await updateUserPrivacySettings("user-123", {
        hideHistory: true,
        hideFromSearch: true,
      });

      expect(updated).toEqual({ hideHistory: true, hideFromSearch: true });
      expect(mockUserDoc.save).toHaveBeenCalled();
    });
  });
});
