import { validateBuildEnv } from "../build";
import { clientEnv } from "../client";
import { CLIENT_ENV_VARS, EnvValidationError, SERVER_ENV_VARS, checkEnv, findPublicSecretExposures } from "../spec";

const SEED = `S${"A".repeat(55)}`;

/** The minimum a production build needs. */
const complete = () => ({
  NEXT_PUBLIC_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  NEXT_PUBLIC_HORIZON_URL: "https://horizon-testnet.stellar.org",
  NEXT_PUBLIC_FACTORY_CONTRACT_ID: "CFACTORY",
  NEXT_PUBLIC_USDC_CONTRACT_ID: "CUSDC",
});

describe("env schema split", () => {
  it("only declares NEXT_PUBLIC_ variables as client variables", () => {
    for (const name of Object.keys(CLIENT_ENV_VARS)) expect(name).toMatch(/^NEXT_PUBLIC_/);
  });

  it("never declares a NEXT_PUBLIC_ variable as server-only", () => {
    for (const name of Object.keys(SERVER_ENV_VARS)) expect(name).not.toMatch(/^NEXT_PUBLIC_/);
  });

  it("declares no client variable that the secret check would reject", () => {
    const allSet = Object.fromEntries(Object.keys(CLIENT_ENV_VARS).map((name) => [name, "x"]));
    expect(findPublicSecretExposures(allSet)).toEqual([]);
  });

  it("reads every client variable literally so Next.js can inline it", () => {
    expect(Object.keys(clientEnv).sort()).toEqual(Object.keys(CLIENT_ENV_VARS).sort());
    expect(clientEnv.NEXT_PUBLIC_SOROBAN_RPC_URL).toBe("https://soroban-testnet.stellar.org");
  });
});

describe("findPublicSecretExposures", () => {
  it.each(["NEXT_PUBLIC_JWT_SECRET", "NEXT_PUBLIC_ADMIN_API_KEY", "NEXT_PUBLIC_REDIS_URL", "NEXT_PUBLIC_SENTRY_AUTH_TOKEN", "NEXT_PUBLIC_SIGNER_SEED"])(
    "rejects %s by name",
    (name) => {
      expect(findPublicSecretExposures({ [name]: "value" }).map((issue) => issue.name)).toEqual([name]);
    },
  );

  it("rejects a Stellar secret seed under any public name, without echoing it", () => {
    const [issue] = findPublicSecretExposures({ NEXT_PUBLIC_DEMO_ARENA_ID: SEED });
    expect(issue).toEqual({ name: "NEXT_PUBLIC_DEMO_ARENA_ID", message: "holds a Stellar secret seed, which would ship in the browser bundle" });
    expect(issue?.message).not.toContain(SEED);
  });

  it("rejects a PEM private key", () => {
    expect(findPublicSecretExposures({ NEXT_PUBLIC_VAPID_PUBLIC_KEY: "-----BEGIN EC PRIVATE KEY-----\nabc" })).toHaveLength(1);
  });

  it("ignores server variables, public keys and empty values", () => {
    expect(
      findPublicSecretExposures({
        JWT_SECRET: "server side is fine",
        NEXT_PUBLIC_VAPID_PUBLIC_KEY: "BPublicKey",
        NEXT_PUBLIC_SENTRY_DSN: "https://key@sentry.io/1",
        NEXT_PUBLIC_API_KEY: "",
      }),
    ).toEqual([]);
  });
});

describe("checkEnv", () => {
  it("reports missing required and malformed variables", () => {
    const issues = checkEnv(CLIENT_ENV_VARS, { ...complete(), NEXT_PUBLIC_HORIZON_URL: undefined, NEXT_PUBLIC_STELLAR_NETWORK: "devnet" });
    expect(issues.map((issue) => issue.name).sort()).toEqual(["NEXT_PUBLIC_HORIZON_URL", "NEXT_PUBLIC_STELLAR_NETWORK"]);
  });

  it("accepts the network name in any case, as stellarConfig does", () => {
    expect(checkEnv(CLIENT_ENV_VARS, { ...complete(), NEXT_PUBLIC_STELLAR_NETWORK: "MAINNET" })).toEqual([]);
  });
});

describe("validateBuildEnv", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it("passes a complete environment", () => {
    expect(() => validateBuildEnv(complete(), { strict: true })).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("fails a production build on a missing variable, listing it", () => {
    expect(() => validateBuildEnv({}, { strict: true })).toThrow(/NEXT_PUBLIC_SOROBAN_RPC_URL: is required but not set/);
  });

  it("only warns in dev, so pages without Stellar config still render (#1134)", () => {
    expect(() => validateBuildEnv({}, { strict: false })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("NEXT_PUBLIC_HORIZON_URL"));
  });

  it("stays quiet outside build and dev, e.g. under next/jest", () => {
    expect(() => validateBuildEnv({}, { strict: false, warn: false })).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("lets SKIP_ENV_VALIDATION skip schema validation", () => {
    expect(() => validateBuildEnv({ SKIP_ENV_VALIDATION: "1" }, { strict: true })).not.toThrow();
  });

  it("fails on an exposed secret in every phase, even with SKIP_ENV_VALIDATION", () => {
    const source = { ...complete(), SKIP_ENV_VALIDATION: "1", NEXT_PUBLIC_JWT_SECRET: "x" };
    expect(() => validateBuildEnv(source, { strict: false })).toThrow(EnvValidationError);
    expect(() => validateBuildEnv(source, { strict: true })).toThrow(/Secret-looking NEXT_PUBLIC_/);
  });
});
