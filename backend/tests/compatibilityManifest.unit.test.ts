import {
  CLIENT_CAPABILITY_REQUIREMENTS,
  buildCompatibilityManifest,
  type CompatibilityManifestDeps,
} from "../src/services/compatibilityManifest";

const ARENA = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
const FACTORY = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const PASSPHRASE = "Test SDF Network ; September 2015";

function deps(overrides: Partial<CompatibilityManifestDeps> = {}): Partial<CompatibilityManifestDeps> {
  return {
    networkPassphrase: () => PASSPHRASE,
    configRevision: async () => 5_000,
    negotiate: async () => 2,
    requiredVersion: () => undefined,
    factoryContractId: () => FACTORY,
    payoutContractId: () => undefined,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("buildCompatibilityManifest (#1491)", () => {
  it("identifies network, config revision, contract instances and named capabilities", async () => {
    const manifest = await buildCompatibilityManifest({ arenaId: ARENA }, deps());

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      network: { passphrase: PASSPHRASE },
      configRevision: 5_000,
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(manifest.contracts).toEqual([
      { kind: "arena", contractId: ARENA, version: 2, status: "negotiated" },
      { kind: "factory", contractId: FACTORY, version: 2, status: "negotiated" },
    ]);
    expect(Object.keys(manifest.capabilities).sort()).toEqual(
      Object.keys(CLIENT_CAPABILITY_REQUIREMENTS).sort(),
    );
    expect(Object.values(manifest.capabilities).every((entry) => entry.status === "supported")).toBe(true);
  });

  it("reports mixed deployment versions per capability", async () => {
    const manifest = await buildCompatibilityManifest(
      { arenaId: ARENA },
      deps({
        negotiate: async () => 2,
        requiredVersion: (kind, entrypoint) => (kind === "arena" && entrypoint === "reveal_choice" ? 3 : undefined),
      }),
    );

    expect(manifest.capabilities.reveal).toEqual({
      status: "unsupported",
      reason: "contract_version",
      requiredVersion: 3,
    });
    expect(manifest.capabilities.join).toEqual({ status: "supported" });
    expect(manifest.capabilities.commit).toEqual({ status: "supported" });
  });

  it("fails closed for version-gated capabilities when negotiation fails, but not for ungated ones", async () => {
    const manifest = await buildCompatibilityManifest(
      { arenaId: ARENA },
      deps({
        negotiate: async () => {
          throw new Error("RPC outage");
        },
        requiredVersion: (_kind, entrypoint) => (entrypoint === "claim" ? 2 : undefined),
      }),
    );

    expect(manifest.contracts.every((entry) => entry.status === "unavailable" && entry.version === null)).toBe(true);
    expect(manifest.capabilities.claim).toEqual({
      status: "unsupported",
      reason: "negotiation_failed",
      requiredVersion: 2,
    });
    expect(manifest.capabilities.join).toEqual({ status: "supported" });
    expect(JSON.stringify(manifest)).not.toContain("RPC outage");
  });

  it("marks arena-scoped, version-gated capabilities unknown when no arena was requested", async () => {
    const manifest = await buildCompatibilityManifest(
      {},
      deps({ requiredVersion: (_kind, entrypoint) => (entrypoint === "join_arena" ? 2 : undefined) }),
    );

    expect(manifest.contracts.map((entry) => entry.kind)).toEqual(["factory"]);
    expect(manifest.capabilities.join).toEqual({ status: "unknown", reason: "contract_not_specified" });
    expect(manifest.capabilities.commit).toEqual({ status: "supported" });
  });

  it("propagates a ledger read failure so no manifest without a revision is issued", async () => {
    await expect(
      buildCompatibilityManifest(
        {},
        deps({
          configRevision: async () => {
            throw new Error("no ledger");
          },
        }),
      ),
    ).rejects.toThrow("no ledger");
  });
});
