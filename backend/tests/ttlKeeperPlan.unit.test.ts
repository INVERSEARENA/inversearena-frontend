/**
 * Unit coverage for the pure TTL renewal planner and manifest validation
 * (#1516). No network / SDK imports.
 */
import {
  DEFAULT_TTL_KEEPER_POLICY,
  classifyHeadroom,
  manifestsFromEnv,
  parseDeploymentManifests,
  planRenewals,
  type TtlContractObservation,
  type TtlKeeperPolicy,
} from "../src/services/ttlKeeperPlan";

const NETWORK = "Test SDF Network ; September 2015";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const CONTRACT_B = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";

const policy: TtlKeeperPolicy = {
  renewBelowLedgers: 1_000,
  maxRenewalsPerRun: 25,
  maxRenewalsPerContract: 10,
};

function contract(overrides: Partial<TtlContractObservation> = {}): TtlContractObservation {
  return {
    contractId: CONTRACT,
    contractKind: "staking",
    manifestNetwork: NETWORK,
    manifestVersion: 2,
    observedNetwork: NETWORK,
    observedVersion: 2,
    keys: [],
    ...overrides,
  };
}

describe("classifyHeadroom (#1516)", () => {
  it("treats a non-positive headroom as expired, not renewable", () => {
    expect(classifyHeadroom(0, policy)).toBe("expired");
    expect(classifyHeadroom(-5, policy)).toBe("expired");
  });

  it("renews strictly below threshold and keeps the boundary healthy", () => {
    expect(classifyHeadroom(999, policy)).toBe("critical");
    // Boundary is `<`, so headroom == threshold is healthy.
    expect(classifyHeadroom(1_000, policy)).toBe("ok");
    expect(classifyHeadroom(1_001, policy)).toBe("ok");
  });
});

describe("planRenewals (#1516)", () => {
  it("renews keys below threshold, ordered by urgency", () => {
    const plan = planRenewals(
      [
        contract({
          keys: [
            { key: "TSTAKE", present: true, liveUntilLedger: 100_500 + 900 },
            { key: "ADMIN", present: true, liveUntilLedger: 100_500 + 10 },
            { key: "TOKEN", present: true, liveUntilLedger: 100_500 + 400 },
          ],
        }),
      ],
      { currentLedger: 100_500, policy },
    );
    expect(plan.renew.map((r) => r.key)).toEqual(["ADMIN", "TOKEN", "TSTAKE"]);
    expect(plan.renew[0].headroom).toBe(10);
  });

  it("skips healthy keys at and above the threshold", () => {
    const plan = planRenewals(
      [
        contract({
          keys: [
            { key: "TSTAKE", present: true, liveUntilLedger: 100_500 + 1_000 },
            { key: "ADMIN", present: true, liveUntilLedger: 100_500 + 5_000 },
          ],
        }),
      ],
      { currentLedger: 100_500, policy },
    );
    expect(plan.renew).toHaveLength(0);
    expect(plan.skip.map((s) => s.reason)).toEqual(["healthy", "healthy"]);
  });

  it("never proposes renewal for an already-expired key", () => {
    const plan = planRenewals(
      [contract({ keys: [{ key: "ADMIN", present: true, liveUntilLedger: 100_000 }] })],
      { currentLedger: 100_500, policy },
    );
    expect(plan.renew).toHaveLength(0);
    expect(plan.skip[0]).toMatchObject({ key: "ADMIN", reason: "expired", headroom: -500 });
  });

  it("skips absent and unreadable keys distinctly", () => {
    const plan = planRenewals(
      [
        contract({
          keys: [
            { key: "P_ADMIN", present: false, liveUntilLedger: null },
            { key: "TSTAKE", present: true, liveUntilLedger: null },
          ],
        }),
      ],
      { currentLedger: 100_500, policy },
    );
    expect(plan.renew).toHaveLength(0);
    expect(plan.skip.map((s) => s.reason).sort()).toEqual(["absent", "unreadable"]);
  });

  it("fails closed when the contract identity is uncertain", () => {
    const plan = planRenewals(
      [
        contract({
          observedVersion: null,
          keys: [{ key: "ADMIN", present: true, liveUntilLedger: 100_501 }],
        }),
      ],
      { currentLedger: 100_500, policy },
    );
    expect(plan.renew).toHaveLength(0);
    expect(plan.skip).toEqual([
      { contractId: CONTRACT, contractKind: "staking", key: null, reason: "identity_uncertain", headroom: null },
    ]);
  });

  it("refuses to renew across a network or version mismatch", () => {
    const network = planRenewals(
      [contract({ observedNetwork: "Public Global Stellar Network ; September 2015" })],
      { currentLedger: 100_500, policy },
    );
    expect(network.skip[0].reason).toBe("network_mismatch");

    const version = planRenewals([contract({ observedVersion: 1 })], {
      currentLedger: 100_500,
      policy,
    });
    expect(version.skip[0].reason).toBe("version_mismatch");
  });

  it("bounds renewals per contract and marks the overflow rate_limited", () => {
    const keys = Array.from({ length: 5 }, (_, i) => ({
      key: `K${i}`,
      present: true,
      liveUntilLedger: 100_500 + (5 - i),
    }));
    const plan = planRenewals([contract({ keys })], {
      currentLedger: 100_500,
      policy: { ...policy, maxRenewalsPerContract: 2 },
    });
    expect(plan.renew).toHaveLength(2);
    expect(plan.skip.filter((s) => s.reason === "rate_limited")).toHaveLength(3);
    // Rate-limited keys keep their headroom for the next run.
    expect(plan.skip.find((s) => s.reason === "rate_limited")?.headroom).toBeGreaterThan(0);
  });

  it("bounds renewals across all contracts per run", () => {
    const plan = planRenewals(
      [
        contract({
          keys: [
            { key: "ADMIN", present: true, liveUntilLedger: 100_501 },
            { key: "TSTAKE", present: true, liveUntilLedger: 100_502 },
          ],
        }),
        contract({
          contractId: CONTRACT_B,
          keys: [{ key: "ADMIN", present: true, liveUntilLedger: 100_503 }],
        }),
      ],
      { currentLedger: 100_500, policy: { ...policy, maxRenewalsPerRun: 2 } },
    );
    expect(plan.renew).toHaveLength(2);
    expect(plan.skip.filter((s) => s.reason === "rate_limited")).toHaveLength(1);
  });

  it("is deterministic and idempotent for the same observation", () => {
    const observation = [
      contract({
        keys: [
          { key: "TSTAKE", present: true, liveUntilLedger: 100_550 },
          { key: "ADMIN", present: true, liveUntilLedger: 100_510 },
        ],
      }),
    ];
    const context = { currentLedger: 100_500, policy };
    expect(planRenewals(observation, context)).toEqual(planRenewals(observation, context));
  });
});

describe("deployment manifest validation (#1516)", () => {
  it("accepts a well-formed manifest", () => {
    const [manifest] = parseDeploymentManifests([
      { contractId: CONTRACT, kind: "staking", network: NETWORK, version: 2 },
    ]);
    expect(manifest).toEqual({ contractId: CONTRACT, kind: "staking", network: NETWORK, version: 2 });
  });

  it("rejects a malformed contract id, bad version, and duplicates", () => {
    expect(() => parseDeploymentManifests([{ contractId: "nope", kind: "staking", network: NETWORK, version: 1 }])).toThrow(
      /contractId/,
    );
    expect(() =>
      parseDeploymentManifests([{ contractId: CONTRACT, kind: "staking", network: NETWORK, version: 0 }]),
    ).toThrow(/version/);
    expect(() =>
      parseDeploymentManifests([
        { contractId: CONTRACT, kind: "staking", network: NETWORK, version: 1 },
        { contractId: CONTRACT, kind: "staking", network: NETWORK, version: 1 },
      ]),
    ).toThrow(/duplicate/);
  });

  it("returns [] for an unset env var and throws on invalid JSON", () => {
    expect(manifestsFromEnv(undefined)).toEqual([]);
    expect(manifestsFromEnv("   ")).toEqual([]);
    expect(() => manifestsFromEnv("{not json")).toThrow(/valid JSON/);
  });

  it("exposes a sane default policy", () => {
    expect(DEFAULT_TTL_KEEPER_POLICY.renewBelowLedgers).toBeGreaterThan(0);
    expect(DEFAULT_TTL_KEEPER_POLICY.maxRenewalsPerRun).toBeGreaterThan(0);
  });
});
