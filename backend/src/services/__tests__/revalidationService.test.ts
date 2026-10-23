import {
  RevalidationService,
  signRevalidationBody,
  REVALIDATE_SIGNATURE_HEADER,
  REVALIDATE_TIMESTAMP_HEADER,
} from "../revalidationService";

jest.mock("../../cache/cacheService", () => ({
  cache: { invalidate: jest.fn(async () => undefined) },
  tags: {
    arenas: () => "arenas:list",
    leaderboard: () => "leaderboard",
  },
}));

jest.mock("../contractCapability", () => ({
  invalidateContractCapability: jest.fn(),
}));

import { cache } from "../../cache/cacheService";
import { invalidateContractCapability } from "../contractCapability";

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("RevalidationService (#1626)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("purges the global cache tags and invalidates named contracts", async () => {
    const service = new RevalidationService({
      frontendOrigin: "https://app.example.com",
      secret: "shared-secret-value",
      fetchImpl: jest.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    });

    const result = await service.revalidateConfig("factory_upgrade", [CONTRACT]);

    expect(cache.invalidate).toHaveBeenCalledWith("arenas:list");
    expect(cache.invalidate).toHaveBeenCalledWith("leaderboard");
    expect(invalidateContractCapability).toHaveBeenCalledWith(CONTRACT, "upgrade_detected");
    expect(result.invalidatedContracts).toEqual([CONTRACT]);
    expect(result.frontendNotified).toBe(true);
  });

  it("signs the frontend webhook with the timestamped HMAC", async () => {
    const fetchImpl = jest.fn(async () => new Response(null, { status: 200 }));
    const service = new RevalidationService({
      frontendOrigin: "https://app.example.com",
      secret: "shared-secret-value",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await service.revalidateConfig("fee_schedule");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://app.example.com/api/revalidate");
    const headers = init.headers as Record<string, string>;
    const timestamp = headers[REVALIDATE_TIMESTAMP_HEADER]!;
    const expected = signRevalidationBody("shared-secret-value", timestamp, init.body as string);
    expect(headers[REVALIDATE_SIGNATURE_HEADER]).toBe(expected);
  });

  it("skips the frontend when no secret is configured", async () => {
    const fetchImpl = jest.fn(async () => new Response(null, { status: 200 }));
    const service = new RevalidationService({
      frontendOrigin: "https://app.example.com",
      secret: undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await service.revalidateConfig("contract_upgrade", [CONTRACT]);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.frontendNotified).toBe(false);
    // Backend caches are still purged even without the frontend webhook.
    expect(cache.invalidate).toHaveBeenCalled();
  });

  it("does not throw when the frontend webhook fails", async () => {
    const fetchImpl = jest.fn(async () => new Response("nope", { status: 500 }));
    const service = new RevalidationService({
      frontendOrigin: "https://app.example.com",
      secret: "shared-secret-value",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await service.revalidateConfig("contract_upgrade");

    expect(result.frontendNotified).toBe(false);
    expect(result.frontendError).toContain("500");
  });
});
