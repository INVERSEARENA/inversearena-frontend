import {
  computePortfolioRiskSummary,
  PORTFOLIO_RISK_DISCLAIMER,
  groupKey,
  type GroupEvidence,
  type PortfolioPosition,
} from "../../src/domain/portfolioRiskRules";

const HEALTHY: GroupEvidence = {
  reserve: { status: "available", value: "healthy" },
  oracle: { status: "available", value: "fresh" },
  registry: { status: "available", value: "active" },
  arenaHealth: { status: "available", value: "healthy" },
  contractVersion: { status: "available", value: 3 },
  ledger: 500,
};

function position(overrides: Partial<PortfolioPosition> & Pick<PortfolioPosition, "positionId">): PortfolioPosition {
  return {
    kind: "active",
    asset: "USDC",
    vaultId: "VAULT_A",
    oracleId: "ORACLE_A",
    arenaId: "ARENA_1",
    lifecycle: "open",
    amountMinor: "1000",
    observedLedger: 490,
    ...overrides,
  };
}

function summarize(
  positions: PortfolioPosition[],
  evidence: Record<string, GroupEvidence> = {},
  snapshotLedger = 500,
) {
  return computePortfolioRiskSummary({ positions, snapshotLedger, evidence, supportedContractVersion: 3 });
}

describe("computePortfolioRiskSummary (#1691)", () => {
  it("never sums amounts across different assets", () => {
    const usdc = position({ positionId: "p1", asset: "USDC", amountMinor: "100" });
    const xlm = position({ positionId: "p2", asset: "XLM", amountMinor: "250" });
    const summary = summarize([usdc, xlm], { [groupKey(usdc)]: HEALTHY, [groupKey(xlm)]: HEALTHY });
    expect(summary.groups.map((group) => [group.asset, group.exposureMinor])).toEqual([
      ["USDC", "100"],
      ["XLM", "250"],
    ]);
  });

  it("concentrates shared-vault exposure into one group with exact minor units", () => {
    const first = position({ positionId: "p1", amountMinor: "12345678901234567890" });
    const second = position({ positionId: "p2", amountMinor: "1" });
    const summary = summarize([first, second], { [groupKey(first)]: HEALTHY });
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]).toMatchObject({ exposureMinor: "12345678901234567891", positionCount: 2 });
  });

  it("signals action_required on a reserve shortfall", () => {
    const p = position({ positionId: "p1" });
    const summary = summarize([p], {
      [groupKey(p)]: { ...HEALTHY, reserve: { status: "available", value: "shortfall" } },
    });
    expect(summary.overall).toEqual({ severity: "action_required", reasons: ["reserve_shortfall"] });
  });

  it("signals attention for stale oracle data and deprecated integrations", () => {
    const p = position({ positionId: "p1" });
    const summary = summarize([p], {
      [groupKey(p)]: {
        ...HEALTHY,
        oracle: { status: "available", value: "stale" },
        registry: { status: "available", value: "deprecated" },
      },
    });
    expect(summary.overall).toEqual({ severity: "attention", reasons: ["integration_deprecated", "oracle_stale"] });
  });

  it("maps arena health to severity", () => {
    const p = position({ positionId: "p1" });
    const degraded = summarize([p], { [groupKey(p)]: { ...HEALTHY, arenaHealth: { status: "available", value: "degraded" } } });
    const critical = summarize([p], { [groupKey(p)]: { ...HEALTHY, arenaHealth: { status: "available", value: "critical" } } });
    expect(degraded.overall.severity).toBe("attention");
    expect(critical.overall.severity).toBe("action_required");
  });

  it("keeps verified groups when one evidence source is unavailable", () => {
    const good = position({ positionId: "p1", asset: "USDC" });
    const partial = position({ positionId: "p2", asset: "XLM" });
    const summary = summarize([good, partial], {
      [groupKey(good)]: HEALTHY,
      [groupKey(partial)]: { ...HEALTHY, oracle: { status: "unavailable", reason: "rpc_timeout" } },
    });
    const byAsset = Object.fromEntries(summary.groups.map((group) => [group.asset, group]));
    expect(byAsset.USDC.dataAvailability).toBe("complete");
    expect(byAsset.XLM.dataAvailability).toBe("partial");
    expect(byAsset.XLM.signal).toEqual({ severity: "attention", reasons: ["oracle_unavailable"] });
    expect(byAsset.USDC.exposureMinor).toBe("1000");
  });

  it("marks a group with no evidence at all as partial and attention", () => {
    const summary = summarize([position({ positionId: "p1" })], {});
    expect(summary.groups[0]).toMatchObject({ dataAvailability: "partial", evidence: null });
    expect(summary.groups[0].signal).toEqual({ severity: "attention", reasons: ["evidence_unavailable"] });
  });

  it("flags a contract version newer than this build supports", () => {
    const p = position({ positionId: "p1" });
    const summary = summarize([p], { [groupKey(p)]: { ...HEALTHY, contractVersion: { status: "available", value: 9 } } });
    expect(summary.overall).toEqual({ severity: "attention", reasons: ["unsupported_contract_version"] });
  });

  it("reports claimable finished arenas as informational notices", () => {
    const p = position({ positionId: "p1", kind: "claimable", lifecycle: "finished" });
    const summary = summarize([p], { [groupKey(p)]: HEALTHY });
    expect(summary.overall).toEqual({ severity: "informational", reasons: ["claim_available"] });
  });

  it("excludes duplicate positions so replays cannot inflate exposure", () => {
    const p = position({ positionId: "p1", amountMinor: "500" });
    const summary = summarize([p, { ...p }], { [groupKey(p)]: HEALTHY });
    expect(summary.groups[0]).toMatchObject({ exposureMinor: "500", positionCount: 1 });
    expect(summary.excluded).toEqual([{ positionId: "p1", reason: "duplicate" }]);
  });

  it("excludes zero-value, malformed and ledger-rolled-back positions with a reason", () => {
    const summary = summarize([
      position({ positionId: "zero", amountMinor: "0" }),
      position({ positionId: "bad", amountMinor: "-5" }),
      position({ positionId: "future", observedLedger: 999 }),
      position({ positionId: "ok", amountMinor: "10" }),
    ]);
    expect(summary.excluded).toEqual([
      { positionId: "zero", reason: "zero_value" },
      { positionId: "bad", reason: "invalid_amount" },
      { positionId: "future", reason: "ledger_rollback" },
    ]);
    expect(summary.groups[0].exposureMinor).toBe("10");
  });

  it("is deterministic regardless of input order", () => {
    const a = position({ positionId: "a", asset: "XLM" });
    const b = position({ positionId: "b", asset: "USDC" });
    const evidence = { [groupKey(a)]: HEALTHY, [groupKey(b)]: HEALTHY };
    expect(summarize([a, b], evidence)).toEqual(summarize([b, a], evidence));
  });

  it("always carries the non-advisory disclaimer and snapshot ledger", () => {
    const summary = summarize([]);
    expect(summary.disclaimer).toBe(PORTFOLIO_RISK_DISCLAIMER);
    expect(summary.snapshotLedger).toBe(500);
    expect(summary.overall).toEqual({ severity: "informational", reasons: [] });
  });
});
