import { PriceService, type PriceOracleSource, type CachedPrice } from "../priceService";

function makeMockSource(
  data: Record<string, { price: bigint; decimals: number; timestamp: number } | null>,
): PriceOracleSource {
  return {
    lastprice: async (assetCode) => data[assetCode] ?? null,
  };
}

describe("PriceService", () => {
  const now = Math.floor(Date.now() / 1000);

  it("returns a price from a fresh oracle response", async () => {
    const source = makeMockSource({
      XLM: { price: 10_000_000n, decimals: 7, timestamp: now },
    });
    const service = new PriceService(source, { staleAfterSeconds: 300 });
    const result = await service.getPrice("XLM");
    expect(result).not.toBeNull();
    expect(result!.priceUsd).toBeCloseTo(1.0);
    expect(result!.stale).toBe(false);
  });

  it("marks a price stale when oracle timestamp is old", async () => {
    const source = makeMockSource({
      USDC: { price: 100_000_000n, decimals: 8, timestamp: now - 700 },
    });
    const service = new PriceService(source, { staleAfterSeconds: 600 });
    const result = await service.getPrice("USDC");
    expect(result).not.toBeNull();
    expect(result!.stale).toBe(true);
  });

  it("returns null for an unsupported asset", async () => {
    const source = makeMockSource({});
    const service = new PriceService(source);
    const result = await service.getPrice("UNKNOWN");
    expect(result).toBeNull();
  });

  it("toFiat returns null when price is stale", async () => {
    const source = makeMockSource({
      XLM: { price: 10_000_000n, decimals: 7, timestamp: now - 700 },
    });
    const service = new PriceService(source, { staleAfterSeconds: 600 });
    const fiat = await service.toFiat("XLM", 1_000_000_0n, 7);
    expect(fiat).toBeNull();
  });

  it("toFiat converts a raw amount to USD", async () => {
    const source = makeMockSource({
      XLM: { price: 20_000_000n, decimals: 7, timestamp: now },
    });
    const service = new PriceService(source, { staleAfterSeconds: 600 });
    const fiat = await service.toFiat("XLM", 1_000_000_0n, 7);
    expect(fiat).not.toBeNull();
    expect(fiat!.usd).toBeCloseTo(2.0);
  });
});
