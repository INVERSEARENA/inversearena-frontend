/**
 * Watchlist Service — unit tests (#1402). Covers watch/unwatch
 * idempotency, arena-existence validation, the max-size limit, and
 * cross-user isolation.
 */

const fakeUsers = new Map<string, { watchedArenaIds: string[] }>();

jest.mock("../src/db/models/user.model", () => ({
  UserModel: {
    findById: jest.fn((id: string) => {
      const doc = fakeUsers.get(id) ?? null;
      const result = doc ? { ...doc, _id: { toString: () => id } } : null;
      return { lean: () => Promise.resolve(result) };
    }),
    findByIdAndUpdate: jest.fn((id: string, update: Record<string, unknown>) => {
      const existing = fakeUsers.get(id);
      if (!existing) return { lean: () => Promise.resolve(null) };

      if (update.$addToSet && typeof update.$addToSet === "object") {
        const { watchedArenaIds: toAdd } = update.$addToSet as { watchedArenaIds: string };
        if (!existing.watchedArenaIds.includes(toAdd)) {
          existing.watchedArenaIds = [...existing.watchedArenaIds, toAdd];
        }
      }
      if (update.$pull && typeof update.$pull === "object") {
        const { watchedArenaIds: toRemove } = update.$pull as { watchedArenaIds: string };
        existing.watchedArenaIds = existing.watchedArenaIds.filter((id2) => id2 !== toRemove);
      }

      fakeUsers.set(id, existing);
      return { lean: () => Promise.resolve({ ...existing, _id: { toString: () => id } }) };
    }),
  },
}));

import { WatchlistService } from "../src/services/watchlistService";
import type { PrismaClient } from "@prisma/client";

function makePrisma(existingArenaIds: string[]): PrismaClient {
  return {
    arena: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        existingArenaIds.includes(where.id) ? { id: where.id } : null,
      ),
    },
  } as unknown as PrismaClient;
}

describe("WatchlistService", () => {
  beforeEach(() => {
    fakeUsers.clear();
  });

  describe("watch", () => {
    it("adds a valid arena to an empty watchlist", async () => {
      fakeUsers.set("user-1", { watchedArenaIds: [] });
      const service = new WatchlistService(makePrisma(["arena-1"]));

      const result = await service.watch("user-1", "arena-1");
      expect(result).toEqual(["arena-1"]);
    });

    it("is idempotent: watching an already-watched arena returns the list unchanged", async () => {
      fakeUsers.set("user-1", { watchedArenaIds: ["arena-1"] });
      const prisma = makePrisma(["arena-1"]);
      const service = new WatchlistService(prisma);

      const result = await service.watch("user-1", "arena-1");
      expect(result).toEqual(["arena-1"]);
      // Idempotent no-op should not even need to re-validate arena existence.
      expect((prisma.arena.findUnique as jest.Mock)).not.toHaveBeenCalled();
    });

    it("rejects watching a nonexistent arena", async () => {
      fakeUsers.set("user-1", { watchedArenaIds: [] });
      const service = new WatchlistService(makePrisma([]));

      await expect(service.watch("user-1", "missing-arena")).rejects.toMatchObject({ status: 404 });
    });

    it("rejects watching for a nonexistent user", async () => {
      const service = new WatchlistService(makePrisma(["arena-1"]));
      await expect(service.watch("missing-user", "arena-1")).rejects.toMatchObject({ status: 404 });
    });

    it("enforces the max watchlist size", async () => {
      const many = Array.from({ length: 200 }, (_, i) => `arena-${i}`);
      fakeUsers.set("user-1", { watchedArenaIds: many });
      const service = new WatchlistService(makePrisma(["arena-new"]));

      await expect(service.watch("user-1", "arena-new")).rejects.toMatchObject({ status: 409 });
    });

    it("scopes watchlists per user", async () => {
      fakeUsers.set("user-1", { watchedArenaIds: ["arena-1"] });
      fakeUsers.set("user-2", { watchedArenaIds: [] });
      const service = new WatchlistService(makePrisma(["arena-1", "arena-2"]));

      await service.watch("user-2", "arena-2");

      expect(await service.list("user-1")).toEqual(["arena-1"]);
      expect(await service.list("user-2")).toEqual(["arena-2"]);
    });
  });

  describe("unwatch", () => {
    it("removes a watched arena", async () => {
      fakeUsers.set("user-1", { watchedArenaIds: ["arena-1", "arena-2"] });
      const service = new WatchlistService(makePrisma(["arena-1", "arena-2"]));

      const result = await service.unwatch("user-1", "arena-1");
      expect(result).toEqual(["arena-2"]);
    });

    it("is idempotent: unwatching an arena that isn't watched returns the list unchanged", async () => {
      fakeUsers.set("user-1", { watchedArenaIds: ["arena-2"] });
      const service = new WatchlistService(makePrisma(["arena-1", "arena-2"]));

      const result = await service.unwatch("user-1", "arena-1");
      expect(result).toEqual(["arena-2"]);
    });

    it("rejects unwatching for a nonexistent user", async () => {
      const service = new WatchlistService(makePrisma([]));
      await expect(service.unwatch("missing-user", "arena-1")).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("list", () => {
    it("returns an empty list for a user with nothing watched", async () => {
      fakeUsers.set("user-1", { watchedArenaIds: [] });
      const service = new WatchlistService(makePrisma([]));
      expect(await service.list("user-1")).toEqual([]);
    });

    it("rejects listing for a nonexistent user", async () => {
      const service = new WatchlistService(makePrisma([]));
      await expect(service.list("missing-user")).rejects.toMatchObject({ status: 404 });
    });
  });
});
