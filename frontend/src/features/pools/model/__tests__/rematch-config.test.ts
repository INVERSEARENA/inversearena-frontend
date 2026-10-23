import {
  entryFeeToStakeAmount,
  roundDurationToSpeed,
  currencyForStakeToken,
  toRematchFormPrefill,
  fetchRematchConfig,
  recordRematchArena,
  RematchConfigError,
  type RematchConfig,
} from "../rematch-config";

jest.mock("@/shared/config/stellarConfig", () => ({
  stellarConfig: {
    usdcContractId: "CUSDC00000000000000000000000000000000000000000000000000000000",
    xlmContractId: "CXLM000000000000000000000000000000000000000000000000000000000",
  },
}));

const baseConfig: RematchConfig = {
  arenaId: "CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3",
  available: true,
  blockedReason: null,
  blockedMessage: null,
  host: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
  poolId: 12,
  factoryContractId: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
  isPriorParticipant: false,
  config: {
    stakeToken: "CUSDC00000000000000000000000000000000000000000000000000000000",
    yieldVault: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    entryFee: "1000000000",
    oracleContract: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    minPlayers: 2,
    maxPlayers: 8,
    roundDuration: 60,
  },
};

describe("rematch-config helpers (#1572)", () => {
  describe("entryFeeToStakeAmount", () => {
    it("converts a 7-decimal token amount to a form value", () => {
      expect(entryFeeToStakeAmount("1000000000")).toBe("100");
    });

    it("keeps fractional precision and trims trailing zeros", () => {
      expect(entryFeeToStakeAmount("15000000")).toBe("1.5");
    });

    it("returns an empty string for a non-positive amount", () => {
      expect(entryFeeToStakeAmount("0")).toBe("");
      expect(entryFeeToStakeAmount("garbage")).toBe("");
    });
  });

  describe("roundDurationToSpeed", () => {
    it("maps to the nearest supported round speed", () => {
      expect(roundDurationToSpeed(30)).toBe("30S");
      expect(roundDurationToSpeed(60)).toBe("1M");
      expect(roundDurationToSpeed(300)).toBe("5M");
      // An unrecorded duration (0) must not blow up the mapping.
      expect(roundDurationToSpeed(0)).toBe("30S");
    });
  });

  describe("currencyForStakeToken", () => {
    it("recognises the configured token contracts", () => {
      expect(currencyForStakeToken("CUSDC00000000000000000000000000000000000000000000000000000000")).toBe(
        "USDC",
      );
      expect(currencyForStakeToken("CXLM000000000000000000000000000000000000000000000000000000000")).toBe(
        "XLM",
      );
    });

    it("returns null for an unrecognised token", () => {
      expect(currencyForStakeToken("CUNKNOWN")).toBeNull();
    });
  });

  describe("toRematchFormPrefill", () => {
    it("derives the form fields from the on-chain config", () => {
      expect(toRematchFormPrefill(baseConfig)).toEqual({
        stakeAmountInput: "100",
        currency: "USDC",
        roundSpeed: "1M",
        arenaCapacity: 8,
      });
    });

    it("returns null when the rematch is blocked", () => {
      expect(
        toRematchFormPrefill({
          ...baseConfig,
          available: false,
          blockedReason: "SOURCE_ARENA_NOT_FINISHED",
        }),
      ).toBeNull();
    });

    it("returns null when no config was returned", () => {
      expect(toRematchFormPrefill({ ...baseConfig, config: null })).toBeNull();
    });
  });

  describe("fetchRematchConfig", () => {
    const fetchMock = jest.fn();
    beforeEach(() => {
      jest.clearAllMocks();
      window.localStorage.clear();
      global.fetch = fetchMock as unknown as typeof fetch;
    });

    it("returns the parsed config and attaches the auth header", async () => {
      window.localStorage.setItem("access_token", "tok");
      fetchMock.mockResolvedValue({ ok: true, json: async () => baseConfig });

      await expect(fetchRematchConfig("ARENA")).resolves.toEqual(baseConfig);
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/arenas/ARENA/rematch-config",
        expect.objectContaining({
          headers: { Authorization: "Bearer tok" },
        }),
      );
    });

    it("surfaces the status code and server message on failure", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ message: "config unavailable" }),
      });

      await expect(fetchRematchConfig("ARENA")).rejects.toMatchObject({
        status: 503,
        message: "config unavailable",
      });
    });
  });

  describe("recordRematchArena", () => {
    const fetchMock = jest.fn();
    beforeEach(() => {
      jest.clearAllMocks();
      window.localStorage.clear();
      global.fetch = fetchMock as unknown as typeof fetch;
    });

    it("POSTs the linkage and the confirmed tx hash", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ arena: { id: "CNEWARENA" } }),
      });

      await expect(
        recordRematchArena({
          txHash: "a".repeat(64),
          rematchOf: "CSOURCE",
          sourceArenaId: "CSOURCE",
          entryFee: 100,
          maxPlayers: 8,
          stakeToken: "USDC",
        }),
      ).resolves.toEqual({ id: "CNEWARENA" });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/arenas");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toMatchObject({
        txHash: "a".repeat(64),
        rematchOf: "CSOURCE",
        maxPlayers: 8,
        stakeToken: "USDC",
      });
    });

    it("throws a RematchConfigError when the backend rejects the linkage", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ message: "conflict" }),
      });

      await expect(
        recordRematchArena({
          txHash: "a".repeat(64),
          rematchOf: "CSOURCE",
          sourceArenaId: "CSOURCE",
          entryFee: 100,
          maxPlayers: 8,
          stakeToken: "USDC",
        }),
      ).rejects.toBeInstanceOf(RematchConfigError);
    });

    it("throws when the response carries no arena id", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({}) });

      await expect(
        recordRematchArena({
          txHash: "a".repeat(64),
          rematchOf: "CSOURCE",
          sourceArenaId: "CSOURCE",
          entryFee: 100,
          maxPlayers: 8,
          stakeToken: "USDC",
        }),
      ).rejects.toBeInstanceOf(RematchConfigError);
    });
  });
});
