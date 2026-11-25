import { SorobanRpcPool, type ProviderHealthStats } from "../sorobanRpcPool";

const mockServers = new Map<string, {
  getLatestLedger: jest.Mock;
  simulateTransaction: jest.Mock;
  sendTransaction: jest.Mock;
  getTransaction: jest.Mock;
  getLedgerEntries: jest.Mock;
  getEvents: jest.Mock;
}>();

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: jest.fn().mockImplementation((url: string) => {
        const cleanUrl = url.replace(/\/+$/, "");
        if (!mockServers.has(cleanUrl)) {
          mockServers.set(cleanUrl, {
            getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1000, id: "ledger-1000" }),
            simulateTransaction: jest.fn().mockResolvedValue({ results: [] }),
            sendTransaction: jest.fn().mockResolvedValue({ hash: "tx-hash-123", status: "PENDING" }),
            getTransaction: jest.fn().mockResolvedValue({ status: "SUCCESS", ledger: 1001 }),
            getLedgerEntries: jest.fn().mockResolvedValue({ entries: [] }),
            getEvents: jest.fn().mockResolvedValue({ events: [] }),
          });
        }
        return mockServers.get(cleanUrl)!;
      }),
    },
  };
});

describe("SorobanRpcPool (#1830)", () => {
  beforeEach(() => {
    mockServers.clear();
  });

  it("requires at least one URL", () => {
    expect(() => new SorobanRpcPool({ urls: [] })).toThrow("requires at least one RPC URL");
  });

  it("deduplicates and normalizes trailing slashes", () => {
    const pool = new SorobanRpcPool({
      urls: ["https://rpc-a.example.com/", "https://rpc-a.example.com", "https://rpc-b.example.com"],
    });
    expect(pool.getProviders()).toEqual([
      "https://rpc-a.example.com",
      "https://rpc-b.example.com",
    ]);
  });

  it("fails over automatically when the primary provider is down", async () => {
    const failovers: Array<{ from: string; to: string }> = [];
    const pool = new SorobanRpcPool({
      urls: ["https://rpc-down.example.com", "https://rpc-up.example.com"],
      onFailover: (from, to) => failovers.push({ from, to }),
    });

    const downServer = mockServers.get("https://rpc-down.example.com")!;
    const upServer = mockServers.get("https://rpc-up.example.com")!;

    downServer.simulateTransaction.mockRejectedValue(new Error("ECONNREFUSED"));
    upServer.simulateTransaction.mockResolvedValue({ results: [{ xdr: "ok" }] });

    const res = await pool.simulateTransaction({} as never);
    expect(res).toEqual({ results: [{ xdr: "ok" }] });
    expect(downServer.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(upServer.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(failovers).toEqual([
      { from: "https://rpc-down.example.com", to: "https://rpc-up.example.com" },
    ]);
  });

  it("excludes providers that lag more than maxLedgerLag behind the pool highest ledger", async () => {
    const pool = new SorobanRpcPool({
      urls: ["https://rpc-lagging.example.com", "https://rpc-fresh.example.com"],
      maxLedgerLag: 5,
    });

    const laggingServer = mockServers.get("https://rpc-lagging.example.com")!;
    const freshServer = mockServers.get("https://rpc-fresh.example.com")!;

    laggingServer.getLatestLedger.mockResolvedValue({ sequence: 1000, id: "l-1000" });
    freshServer.getLatestLedger.mockResolvedValue({ sequence: 1020, id: "l-1020" });

    await pool.updateLedgerLag();

    const stats = pool.getHealthStats();
    const laggingStats = stats.find((s) => s.url === "https://rpc-lagging.example.com")!;
    const freshStats = stats.find((s) => s.url === "https://rpc-fresh.example.com")!;

    expect(laggingStats.ledgerLag).toBe(20);
    expect(laggingStats.isLagging).toBe(true);
    expect(freshStats.ledgerLag).toBe(0);
    expect(freshStats.isLagging).toBe(false);

    // Subsequent reads must route exclusively to the fresh provider
    await pool.simulateTransaction({} as never);
    expect(freshServer.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(laggingServer.simulateTransaction).not.toHaveBeenCalled();
  });

  it("keeps getTransaction sticky to the provider that submitted sendTransaction, with fallback", async () => {
    const pool = new SorobanRpcPool({
      urls: ["https://rpc-1.example.com", "https://rpc-2.example.com"],
    });

    const server1 = mockServers.get("https://rpc-1.example.com")!;
    const server2 = mockServers.get("https://rpc-2.example.com")!;

    server1.sendTransaction.mockResolvedValue({ hash: "sticky-hash-abc", status: "PENDING" });
    server1.getTransaction.mockResolvedValue({ status: "SUCCESS", ledger: 500 });

    const sendRes = await pool.sendTransaction({} as never);
    expect(sendRes.hash).toBe("sticky-hash-abc");

    // Sticky poll goes to rpc-1
    const pollRes = await pool.getTransaction("sticky-hash-abc");
    expect(pollRes.status).toBe("SUCCESS");
    expect(server1.getTransaction).toHaveBeenCalledWith("sticky-hash-abc");
    expect(server2.getTransaction).not.toHaveBeenCalled();

    // Now simulate rpc-1 failing during polling -> falls back to rpc-2
    server1.getTransaction.mockRejectedValueOnce(new Error("502 Bad Gateway"));
    server2.getTransaction.mockResolvedValueOnce({ status: "SUCCESS", ledger: 501 });

    const fallbackPollRes = await pool.getTransaction("sticky-hash-abc");
    expect(fallbackPollRes).toEqual({ status: "SUCCESS", ledger: 501 });
    expect(server2.getTransaction).toHaveBeenCalledWith("sticky-hash-abc");
  });

  it("scores slower providers lower than fast providers", async () => {
    const metricsSnapshots: ProviderHealthStats[][] = [];
    const pool = new SorobanRpcPool({
      urls: ["https://rpc-slow.example.com", "https://rpc-fast.example.com"],
      onMetricsUpdate: (stats) => metricsSnapshots.push(stats),
    });

    const slowServer = mockServers.get("https://rpc-slow.example.com")!;
    const fastServer = mockServers.get("https://rpc-fast.example.com")!;

    slowServer.getLatestLedger.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ sequence: 1000, id: "l-1000" }), 600)),
    );
    fastServer.getLatestLedger.mockResolvedValue({ sequence: 1000, id: "l-1000" });

    await pool.updateLedgerLag();

    const stats = pool.getHealthStats();
    const slowStats = stats.find((s) => s.url === "https://rpc-slow.example.com")!;
    const fastStats = stats.find((s) => s.url === "https://rpc-fast.example.com")!;

    expect(fastStats.healthScore).toBeGreaterThan(slowStats.healthScore);
    expect(metricsSnapshots.length).toBeGreaterThan(0);
  });
});
