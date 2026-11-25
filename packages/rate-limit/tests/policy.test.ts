import { DEFAULT_POLICY_TABLE, getRoutePolicy } from "../src/policy";

describe("Rate Limit Policy Definitions", () => {
  it("defines policies for all standard route classes", () => {
    expect(DEFAULT_POLICY_TABLE.AUTH_NONCE).toEqual({
      keyPrefix: "rl:auth:nonce",
      points: 5,
      durationSeconds: 60,
    });

    expect(DEFAULT_POLICY_TABLE.AUTH_VERIFY).toEqual({
      keyPrefix: "rl:auth:verify",
      points: 10,
      durationSeconds: 60,
      dualScope: true,
    });

    expect(DEFAULT_POLICY_TABLE.POOLS_CREATE).toEqual({
      keyPrefix: "rl:pools:create",
      points: 3,
      durationSeconds: 60,
    });

    expect(DEFAULT_POLICY_TABLE.ARENAS_SYNC_PLAYERS).toEqual({
      keyPrefix: "rl:arenas:sync-players",
      points: 3,
      durationSeconds: 60,
    });

    expect(DEFAULT_POLICY_TABLE.ARENAS_RESERVATION).toEqual({
      keyPrefix: "rl:arenas:reservation",
      points: 10,
      durationSeconds: 60,
    });

    expect(DEFAULT_POLICY_TABLE.SIMULATIONS).toEqual({
      keyPrefix: "rl:simulations",
      points: 5,
      durationSeconds: 60,
      dualScope: true,
    });
  });

  it("applies environment variable overrides", () => {
    process.env.RATE_LIMIT_NONCE_POINTS = "8";
    process.env.RATE_LIMIT_NONCE_WINDOW_SECONDS = "120";

    const policy = getRoutePolicy("AUTH_NONCE");
    expect(policy.points).toBe(8);
    expect(policy.durationSeconds).toBe(120);

    delete process.env.RATE_LIMIT_NONCE_POINTS;
    delete process.env.RATE_LIMIT_NONCE_WINDOW_SECONDS;
  });
});
