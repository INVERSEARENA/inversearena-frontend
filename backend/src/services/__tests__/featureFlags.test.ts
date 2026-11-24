import {
  bucketOf,
  evaluateAll,
  expiredFlags,
  fnv1a,
  isEnabled,
  isEnabledSafe,
  isExpired,
  validateFlag,
  type FeatureFlag,
} from "../featureFlags";

const WALLET_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const flag = (over: Partial<FeatureFlag> = {}): FeatureFlag => ({
  key: "early-close",
  enabled: true,
  rules: [],
  ...over,
});

describe("fnv1a", () => {
  it("matches the published FNV-1a 32-bit test vectors", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
    expect(fnv1a("foobar")).toBe(0xbf9cf968);
  });
});

describe("bucketOf", () => {
  it("is stable and within 0..9999", () => {
    const b = bucketOf("early-close", "w:" + WALLET_A);
    expect(b).toBe(bucketOf("early-close", "w:" + WALLET_A));
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(10_000);
  });

  it("differs per flag, so one rollout does not pick the same users as another", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `user-${i}`);
    const same = ids.filter((id) => bucketOf("flag-one", id) === bucketOf("flag-two", id));
    expect(same.length).toBeLessThan(10);
  });
});

describe("boolean flags", () => {
  it("is on for everyone when enabled with no audience rules", () => {
    expect(isEnabled(flag())).toBe(true);
    expect(isEnabled(flag(), { wallet: WALLET_A })).toBe(true);
  });

  it("is off when disabled or archived", () => {
    expect(isEnabled(flag({ enabled: false }))).toBe(false);
    expect(isEnabled(flag({ archived: true }))).toBe(false);
  });
});

describe("allowlist rules", () => {
  const f = flag({ rules: [{ kind: "allowlist", wallets: [WALLET_A] }] });

  it("turns the flag on only for listed wallets", () => {
    expect(isEnabled(f, { wallet: WALLET_A })).toBe(true);
    expect(isEnabled(f, { wallet: WALLET_B })).toBe(false);
  });

  it("matches regardless of case and surrounding whitespace", () => {
    expect(isEnabled(f, { wallet: ` ${WALLET_A.toLowerCase()} ` })).toBe(true);
  });

  it("is off for anonymous visitors", () => {
    expect(isEnabled(f, {})).toBe(false);
    expect(isEnabled(f, { anonymousId: "cookie-1" })).toBe(false);
  });
});

describe("percentage rules", () => {
  const pct = (percent: number) => flag({ rules: [{ kind: "percentage", percent }] });
  const wallets = Array.from({ length: 5_000 }, (_, i) => `G${String(i).padStart(55, "0")}`);

  it("0% is off for everyone and 100% is on for everyone", () => {
    expect(wallets.some((wallet) => isEnabled(pct(0), { wallet }))).toBe(false);
    expect(wallets.every((wallet) => isEnabled(pct(100), { wallet }))).toBe(true);
  });

  it("enables about the requested share", () => {
    const on = wallets.filter((wallet) => isEnabled(pct(30), { wallet })).length / wallets.length;
    expect(on).toBeGreaterThan(0.27);
    expect(on).toBeLessThan(0.33);
  });

  it("is sticky: the same wallet always gets the same answer", () => {
    const first = wallets.slice(0, 200).map((wallet) => isEnabled(pct(40), { wallet }));
    const again = wallets.slice(0, 200).map((wallet) => isEnabled(pct(40), { wallet }));
    expect(again).toEqual(first);
  });

  it("only adds wallets when the percentage is raised, never removes them", () => {
    for (const wallet of wallets.slice(0, 1_000)) {
      if (isEnabled(pct(10), { wallet })) expect(isEnabled(pct(25), { wallet })).toBe(true);
      if (isEnabled(pct(25), { wallet })) expect(isEnabled(pct(60), { wallet })).toBe(true);
    }
  });

  it("supports fractional percentages", () => {
    const on = wallets.filter((wallet) => isEnabled(pct(0.5), { wallet })).length;
    expect(on).toBeLessThan(wallets.length * 0.02);
  });

  it("buckets anonymous visitors by their anonymous id", () => {
    const f = pct(50);
    expect(isEnabled(f, { anonymousId: "cookie-9" })).toBe(isEnabled(f, { anonymousId: "cookie-9" }));
    const ids = Array.from({ length: 2_000 }, (_, i) => `cookie-${i}`);
    const on = ids.filter((anonymousId) => isEnabled(f, { anonymousId })).length / ids.length;
    expect(on).toBeGreaterThan(0.45);
    expect(on).toBeLessThan(0.55);
  });

  it("keeps a visitor with no identity out of any rollout below 100%", () => {
    expect(isEnabled(pct(99), {})).toBe(false);
  });

  it("lets an allowlisted wallet in even when the percentage would exclude it", () => {
    const f = flag({ rules: [{ kind: "percentage", percent: 0 }, { kind: "allowlist", wallets: [WALLET_A] }] });
    expect(isEnabled(f, { wallet: WALLET_A })).toBe(true);
    expect(isEnabled(f, { wallet: WALLET_B })).toBe(false);
  });
});

describe("network rules", () => {
  const f = flag({ rules: [{ kind: "network", networks: ["testnet"] }] });

  it("gates the flag to the listed networks", () => {
    expect(isEnabled(f, { network: "testnet" })).toBe(true);
    expect(isEnabled(f, { network: "mainnet" })).toBe(false);
  });

  it("is off when the network is unknown", () => {
    expect(isEnabled(f, {})).toBe(false);
  });

  it("must pass in addition to the audience rules", () => {
    const gated = flag({ rules: [{ kind: "network", networks: ["testnet"] }, { kind: "allowlist", wallets: [WALLET_A] }] });
    expect(isEnabled(gated, { network: "testnet", wallet: WALLET_A })).toBe(true);
    expect(isEnabled(gated, { network: "mainnet", wallet: WALLET_A })).toBe(false);
    expect(isEnabled(gated, { network: "testnet", wallet: WALLET_B })).toBe(false);
  });
});

describe("expiry", () => {
  const now = new Date("2026-11-24T00:00:00Z");

  it("turns a flag off at and after its expiry", () => {
    expect(isEnabled(flag({ expiresAt: "2026-11-24T00:00:00Z" }), { now })).toBe(false);
    expect(isEnabled(flag({ expiresAt: "2026-11-25T00:00:00Z" }), { now })).toBe(true);
  });

  it("treats an unreadable date as expired", () => {
    expect(isExpired({ expiresAt: "not-a-date" }, now)).toBe(true);
  });

  it("reports live flags past their expiry, but not archived ones", () => {
    const stale = flag({ key: "stale", expiresAt: "2026-01-01T00:00:00Z" });
    const archived = flag({ key: "old", expiresAt: "2026-01-01T00:00:00Z", archived: true });
    const fresh = flag({ key: "fresh", expiresAt: "2027-01-01T00:00:00Z" });
    expect(expiredFlags([stale, archived, fresh], now).map((f) => f.key)).toEqual(["stale"]);
  });
});

describe("fail-safe evaluation", () => {
  it("returns false instead of throwing on a malformed flag", () => {
    const broken = { key: "x", enabled: true, rules: null } as unknown as FeatureFlag;
    expect(() => isEnabledSafe(broken, {})).not.toThrow();
    expect(isEnabledSafe(broken, {})).toBe(false);
  });

  it("evaluates a whole set, turning broken flags off", () => {
    const broken = { key: "broken", enabled: true, rules: undefined } as unknown as FeatureFlag;
    expect(evaluateAll([flag(), flag({ key: "off", enabled: false }), broken])).toEqual({
      "early-close": true,
      off: false,
      broken: false,
    });
  });
});

describe("validateFlag", () => {
  it("accepts a well-formed flag", () => {
    expect(validateFlag(flag({ rules: [{ kind: "percentage", percent: 12.5 }] }))).toBeNull();
  });

  it("rejects bad keys", () => {
    expect(validateFlag(flag({ key: "Bad Key" }))).toMatch(/key/);
    expect(validateFlag(flag({ key: "" }))).toMatch(/key/);
  });

  it("rejects out-of-range or over-precise percentages and duplicates", () => {
    expect(validateFlag(flag({ rules: [{ kind: "percentage", percent: 101 }] }))).toMatch(/between 0 and 100/);
    expect(validateFlag(flag({ rules: [{ kind: "percentage", percent: -1 }] }))).toMatch(/between 0 and 100/);
    expect(validateFlag(flag({ rules: [{ kind: "percentage", percent: 1.234 }] }))).toMatch(/two decimals/);
    expect(
      validateFlag(flag({ rules: [{ kind: "percentage", percent: 1 }, { kind: "percentage", percent: 2 }] })),
    ).toMatch(/only one percentage/);
  });

  it("rejects empty allowlist entries, empty network rules and bad expiry dates", () => {
    expect(validateFlag(flag({ rules: [{ kind: "allowlist", wallets: [" "] }] }))).toMatch(/non-empty/);
    expect(validateFlag(flag({ rules: [{ kind: "network", networks: [] }] }))).toMatch(/at least one network/);
    expect(validateFlag(flag({ expiresAt: "soon" }))).toMatch(/expiresAt/);
  });
});
