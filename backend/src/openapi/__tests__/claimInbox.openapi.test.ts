import { generateOpenApiDocument } from "../registerPaths";

/**
 * The claim inbox contract is the one place the service's state machine is
 * published: clients branch on `state` and `reason` instead of inferring them,
 * and `unavailable` has to be rendered as an explicit unknown rather than as an
 * absence. So the published enum members are asserted, not just the path.
 */
describe("claim inbox OpenAPI path", () => {
  const doc = generateOpenApiDocument() as unknown as {
    paths: Record<string, { get: { responses: Record<string, unknown> } }>;
  };
  const operation = doc.paths["/api/users/me/claim-inbox"]?.get;

  it("is published under the wallet-scoped path", () => {
    expect(operation).toBeDefined();
  });

  it("documents the auth and validation failures", () => {
    expect(Object.keys(operation?.responses ?? {})).toEqual(
      expect.arrayContaining(["200", "400", "401"]),
    );
  });

  it("publishes every state and reason a client must branch on", () => {
    const body = JSON.stringify(operation?.responses["200"]);

    for (const state of ["actionable", "pending", "completed", "blocked", "unavailable"]) {
      expect(body).toContain(state);
    }
    for (const reason of [
      "claim_ready",
      "refund_ready",
      "payout_submitted",
      "refund_confirmed",
      "payout_failed",
      "zero_survivor_cancellation",
      "arena_not_finished",
      "rpc_unavailable",
    ]) {
      expect(body).toContain(reason);
    }
  });

  it("publishes stroop amounts as strings, not JSON numbers", () => {
    // A 64-bit balance parsed as a double loses precision on exactly the
    // largest pots, so the published type has to be a string.
    const body = JSON.stringify(operation?.responses["200"]);

    expect(body).toContain("amountStroops");
    expect(body).toMatch(/"type"\s*:\s*"string"/);
  });
});
