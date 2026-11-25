import { fetchServerTimeOffsetMs, ServerTimeFetchError } from "../serverTimeClient";

function mockFetch(response: Partial<Response> & { json: () => Promise<unknown> }): typeof fetch {
  return jest.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

describe("fetchServerTimeOffsetMs", () => {
  const REAL_DATE_NOW = Date.now;

  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  it("returns a positive offset when the server is ahead of the local clock", async () => {
    let call = 0;
    Date.now = jest.fn(() => (call++ === 0 ? 1_000_000 : 1_000_100)); // 100ms round trip

    const fetchImpl = mockFetch({
      ok: true,
      status: 200,
      json: async () => ({ version: 1, serverTimeMs: 1_005_000, issuedAt: "x", token: "t" }),
    });

    const offset = await fetchServerTimeOffsetMs(fetchImpl);

    // estimatedArrival = 1_000_000 + 50 = 1_000_050; offset = 1_005_000 - 1_000_050
    expect(offset).toBe(4_950);
  });

  it("returns zero offset when the server and local clock agree", async () => {
    Date.now = jest.fn(() => 1_000_000);

    const fetchImpl = mockFetch({
      ok: true,
      status: 200,
      json: async () => ({ version: 1, serverTimeMs: 1_000_000, issuedAt: "x", token: "t" }),
    });

    const offset = await fetchServerTimeOffsetMs(fetchImpl);
    expect(offset).toBe(0);
  });

  it("throws ServerTimeFetchError when the network request itself fails", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    await expect(fetchServerTimeOffsetMs(fetchImpl)).rejects.toThrow(ServerTimeFetchError);
  });

  it("throws ServerTimeFetchError for a non-OK response", async () => {
    const fetchImpl = mockFetch({ ok: false, status: 503, json: async () => ({}) });

    await expect(fetchServerTimeOffsetMs(fetchImpl)).rejects.toThrow(ServerTimeFetchError);
  });

  it("throws ServerTimeFetchError for a response missing serverTimeMs", async () => {
    const fetchImpl = mockFetch({ ok: true, status: 200, json: async () => ({ token: "t" }) });

    await expect(fetchServerTimeOffsetMs(fetchImpl)).rejects.toThrow(ServerTimeFetchError);
  });

  it("throws ServerTimeFetchError for a non-JSON response body", async () => {
    const fetchImpl = mockFetch({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("not json");
      },
    });

    await expect(fetchServerTimeOffsetMs(fetchImpl)).rejects.toThrow(ServerTimeFetchError);
  });
});
