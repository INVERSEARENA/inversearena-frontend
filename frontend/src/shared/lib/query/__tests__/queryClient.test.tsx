import {
  createQueryClient,
  queryKeys,
  invalidateOnTxConfirmation,
  invalidateOnSseUpdate,
  clearUserScopedCache,
} from "../queryClient";
import * as balanceCache from "@/shared/lib/stellar/balance-cache";

jest.mock("@/shared/lib/stellar/balance-cache", () => ({
  invalidateWalletBalances: jest.fn(),
  resetBalanceCache: jest.fn(),
}));

describe("Query Cache & Deduplication (#1769)", () => {
  let queryClient: ReturnType<typeof createQueryClient>;

  beforeEach(() => {
    queryClient = createQueryClient();
    jest.clearAllMocks();
  });

  it("deduplicates concurrent queries for the same key", async () => {
    let fetchCount = 0;
    const fetcher = jest.fn(async () => {
      fetchCount++;
      return { result: "ok" };
    });

    const key = queryKeys.arena.hostReputation("GHOST123");

    // Launch two parallel queries with identical queryKey
    const [res1, res2] = await Promise.all([
      queryClient.fetchQuery({ queryKey: key, queryFn: fetcher }),
      queryClient.fetchQuery({ queryKey: key, queryFn: fetcher }),
    ]);

    expect(res1).toEqual({ result: "ok" });
    expect(res2).toEqual({ result: "ok" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetchCount).toBe(1);
  });

  it("invalidates queries and notifies balance cache on transaction confirmation", async () => {
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");
    const testWallet = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

    await invalidateOnTxConfirmation(queryClient, testWallet);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.profile.root });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.claims.root });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.staking.root });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.arena.root });
    expect(balanceCache.invalidateWalletBalances).toHaveBeenCalledWith(testWallet);
  });

  it("clears user-scoped cache on wallet switch", () => {
    const removeSpy = jest.spyOn(queryClient, "removeQueries");

    clearUserScopedCache(queryClient);

    expect(removeSpy).toHaveBeenCalledWith({ queryKey: queryKeys.profile.root });
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: queryKeys.claims.root });
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: queryKeys.staking.root });
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: queryKeys.watchlist.root });
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: queryKeys.wallet.root });
    expect(balanceCache.resetBalanceCache).toHaveBeenCalled();
  });

  it("invalidates queries on SSE updates", async () => {
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");

    await invalidateOnSseUpdate(queryClient, "round_resolved");

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.arena.root });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.leaderboard.root });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.staking.root });
  });
});
