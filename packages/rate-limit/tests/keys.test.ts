import { buildRateLimitKeys } from "../src/keys";

describe("Rate Limit Key Builders", () => {
  it("builds single IP key when no wallet is supplied", () => {
    const keys = buildRateLimitKeys({ ip: "192.168.1.1" });
    expect(keys).toEqual(["ip:192.168.1.1"]);
  });

  it("builds combined IP + wallet key when dualScope is false", () => {
    const keys = buildRateLimitKeys({
      ip: "192.168.1.1",
      walletAddress: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
      dualScope: false,
    });
    expect(keys).toEqual([
      "ip:192.168.1.1:wallet:gbrpyhil2ci3fnq4bxlfmndlfjunpu2hy3zmfshonuceoasw7qc7ox2h",
    ]);
  });

  it("builds separate independent IP and wallet keys when dualScope is true", () => {
    const keys = buildRateLimitKeys({
      ip: "192.168.1.1",
      walletAddress: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
      dualScope: true,
    });
    expect(keys).toEqual([
      "ip:192.168.1.1",
      "wallet:gbrpyhil2ci3fnq4bxlfmndlfjunpu2hy3zmfshonuceoasw7qc7ox2h",
    ]);
  });

  it("applies appNamespace prefix to prevent collisions between apps", () => {
    const keys = buildRateLimitKeys({
      ip: "192.168.1.1",
      walletAddress: "GABCD",
      dualScope: true,
      appNamespace: "frontend:",
    });
    expect(keys).toEqual([
      "frontend:ip:192.168.1.1",
      "frontend:wallet:gabcd",
    ]);
  });
});
