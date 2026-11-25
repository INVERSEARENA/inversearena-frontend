import { describe, expect, it } from "@jest/globals";
import type { rpc } from "@stellar/stellar-sdk";
import { simulationNeedsRestore } from "../../src/services/transactionDiagnosticsService";

type Simulation = Awaited<ReturnType<rpc.Server["simulateTransaction"]>>;

const base = {
  id: "1",
  latestLedger: 10,
  events: [],
  _parsed: true,
  transactionData: {},
  minResourceFee: "100",
  result: { auth: [], retval: {} },
};

describe("simulationNeedsRestore (#1828)", () => {
  it("detects a manual restore preamble", () => {
    const simulation = {
      ...base,
      restorePreamble: { minResourceFee: "200", transactionData: {} },
    } as unknown as Simulation;
    expect(simulationNeedsRestore(simulation)).toBe(true);
  });

  it("detects Protocol 23 auto-restored entries", () => {
    const simulation = {
      ...base,
      archivedSorobanEntries: ["entry-xdr"],
    } as unknown as Simulation;
    expect(simulationNeedsRestore(simulation)).toBe(true);
  });

  it("returns false for a healthy simulation", () => {
    expect(simulationNeedsRestore(base as unknown as Simulation)).toBe(false);
  });
});
