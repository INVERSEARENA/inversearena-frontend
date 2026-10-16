/**
 * Unit coverage for the TTL keeper orchestration (#1516). All side effects are
 * injected fakes, so this runs without the Mongo/Redis harness or RPC.
 */
import { runTtlKeeper, summarizeRun, type TtlKeeperDeps } from "../src/services/ttlKeeperService";
import type { RpcTtlReader, KeyTtl } from "../src/services/onChainTtlReader";
import type { DeploymentManifest } from "../src/services/ttlKeeperPlan";

const NETWORK = "Test SDF Network ; September 2015";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const CONTRACT_B = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";

const manifest = (contractId: string, version = 2): DeploymentManifest => ({
  contractId,
  kind: "staking",
  network: NETWORK,
  version,
});

interface HarnessOptions {
  ledger: number;
  ttls: Record<string, KeyTtl>;
  version?: number | null;
  inventory?: Array<{ key: string; present: boolean }>;
  renewImpl?: (contractId: string) => Promise<void>;
}

function harness(options: HarnessOptions) {
  const renewCalls: string[] = [];
  const deps: TtlKeeperDeps = {
    reader: {
      getLatestLedger: async () => options.ledger,
      getNetworkPassphrase: async () => NETWORK,
      getKeyTtl: async (_contractId: string, key: string): Promise<KeyTtl> =>
        options.ttls[key] ?? { present: true, liveUntilLedger: null },
    } as RpcTtlReader,
    readVersion: async () => (options.version === undefined ? 2 : options.version),
    readInventory: async () =>
      options.inventory ?? [
        { key: "ADMIN", present: true },
        { key: "TSTAKE", present: true },
        { key: "P_ADMIN", present: false },
      ],
    renew: async (contractId: string) => {
      renewCalls.push(contractId);
      if (options.renewImpl) await options.renewImpl(contractId);
    },
  };
  return { deps, renewCalls };
}

const POLICY = { renewBelowLedgers: 1_000, maxRenewalsPerRun: 25, maxRenewalsPerContract: 10 };
const base = () => ({ ledger: 100_500, policy: POLICY });

describe("runTtlKeeper (#1516)", () => {
  it("renews a contract whose keys are below threshold, collapsing to one tx", async () => {
    const { deps, renewCalls } = harness({
      ...base(),
      ttls: {
        ADMIN: { present: true, liveUntilLedger: 100_510 },
        TSTAKE: { present: true, liveUntilLedger: 100_550 },
      },
    });
    deps.manifests = [manifest(CONTRACT)];
    deps.policy = POLICY;

    const run = await runTtlKeeper(deps);

    // ADMIN and TSTAKE both qualify but map to a single contract-wide renewal.
    expect(run.plan.renew.map((r) => r.key)).toEqual(["ADMIN", "TSTAKE"]);
    expect(renewCalls).toEqual([CONTRACT]);
    expect(run.results).toEqual([
      { contractId: CONTRACT, status: "confirmed", keys: ["ADMIN", "TSTAKE"], lagSeconds: 0 },
    ]);
  });

  it("does nothing when all keys are healthy", async () => {
    const { deps, renewCalls } = harness({
      ...base(),
      ttls: {
        ADMIN: { present: true, liveUntilLedger: 200_000 },
        TSTAKE: { present: true, liveUntilLedger: 200_000 },
      },
    });
    deps.manifests = [manifest(CONTRACT)];
    deps.policy = POLICY;

    const run = await runTtlKeeper(deps);
    expect(run.plan.renew).toHaveLength(0);
    expect(renewCalls).toHaveLength(0);
  });

  it("fails closed when the observed version does not match the manifest", async () => {
    const { deps, renewCalls } = harness({
      ...base(),
      version: 1,
      ttls: { ADMIN: { present: true, liveUntilLedger: 100_510 } },
    });
    deps.manifests = [manifest(CONTRACT, 2)];
    deps.policy = POLICY;

    const run = await runTtlKeeper(deps);
    expect(run.plan.renew).toHaveLength(0);
    expect(renewCalls).toHaveLength(0);
    expect(run.plan.skip[0]).toMatchObject({ reason: "version_mismatch" });
  });

  it("records a failed renewal without aborting the rest of the batch", async () => {
    const { deps, renewCalls } = harness({
      ...base(),
      ttls: { ADMIN: { present: true, liveUntilLedger: 100_510 } },
      renewImpl: async (contractId) => {
        if (contractId === CONTRACT) throw new Error("tx rejected");
      },
    });
    deps.manifests = [manifest(CONTRACT), manifest(CONTRACT_B)];
    deps.policy = POLICY;

    const run = await runTtlKeeper(deps);
    // Both contracts are urgent; the first fails, the second still confirms.
    expect(renewCalls).toHaveLength(2);
    const first = run.results.find((r) => r.contractId === CONTRACT);
    const second = run.results.find((r) => r.contractId === CONTRACT_B);
    expect(first).toMatchObject({ status: "failed", error: "tx rejected" });
    expect(second?.status).toBe("confirmed");
  });

  it("is idempotent: duplicate runs produce the same plan and renew again safely", async () => {
    const { deps } = harness({
      ...base(),
      ttls: { ADMIN: { present: true, liveUntilLedger: 100_510 } },
    });
    deps.manifests = [manifest(CONTRACT)];
    deps.policy = POLICY;

    const first = await runTtlKeeper(deps);
    const second = await runTtlKeeper(deps);
    // Planning is a pure function of the (unchanged) observed state, so a
    // restart/duplicate worker re-derives the same plan; on-chain renewal is
    // idempotent, so re-submitting is harmless.
    expect(second.plan).toEqual(first.plan);
  });

  it("skips cleanly when the inventory cannot be read", async () => {
    const { deps, renewCalls } = harness({
      ...base(),
      ttls: {},
    });
    deps.manifests = [manifest(CONTRACT)];
    deps.policy = POLICY;
    deps.readInventory = async () => {
      throw new Error("simulation failed");
    };

    const run = await runTtlKeeper(deps);
    expect(run.plan.renew).toHaveLength(0);
    expect(renewCalls).toHaveLength(0);
  });

  it("summarizeRun exposes a machine-readable dry-run shape", async () => {
    const { deps } = harness({
      ...base(),
      ttls: { ADMIN: { present: true, liveUntilLedger: 100_510 } },
    });
    deps.manifests = [manifest(CONTRACT)];
    deps.policy = POLICY;

    const summary = summarizeRun(await runTtlKeeper(deps));
    expect(summary).toMatchObject({
      currentLedger: 100_500,
      observedNetwork: NETWORK,
      policy: POLICY,
    });
    expect(summary.renew[0]).toMatchObject({ contractId: CONTRACT, key: "ADMIN", headroom: 10 });
  });
});
