/**
 * Integration lifecycle reader for creator templates (#1689).
 *
 * A template names an asset, a yield vault and an oracle. Before a template
 * is saved or applied, those integrations are checked against the factory's
 * registry lifecycle: a deprecated integration is reported (it still settles
 * the arenas that use it, but no new arena can use it) and a withdrawn one
 * is refused.
 *
 * The read is best-effort by design: if the factory cannot be read — an RPC
 * failure, or a deployment that predates the lifecycle views — the
 * integrations are reported as active. A read outage must never invalidate a
 * creator's template.
 */
import { Address, Contract, Keypair, scValToNative } from "@stellar/stellar-sdk";
// TODO(#1495): replace with a backend-owned Stellar gateway behind a typed
// interface; this frontend import crosses package ownership and blocks
// independent backend typecheck/build.
import { StellarRpcGateway } from "../../../frontend/src/shared/lib/stellar/stellarRpcGateway";
import { getStellarConfig, assertAllowedRpcUrl } from "../config/stellarConfig";
import { env } from "../config/env";

export type IntegrationLifecycleState = "Active" | "Deprecated" | "Disabled";

/** The lifecycle states of the requested integrations, keyed by `<kind>:<address>`. */
export type IntegrationLifecycleMap = Record<string, IntegrationLifecycleState>;

const LIFECYCLE_VIEW = {
  token: "get_token_lifecycle",
  vault: "get_vault_lifecycle",
  oracle: "get_oracle_lifecycle",
} as const;

/**
 * Decode the factory's `RegistryEntry` struct.
 *
 * A fieldless Rust enum is encoded as a one-element ScVec, so the decoded
 * state arrives as `["Deprecated"]` rather than `"Deprecated"`.
 */
function decodeState(raw: unknown): IntegrationLifecycleState {
  const record = (raw ?? {}) as Record<string, unknown>;
  const candidate = Array.isArray(record.state) ? record.state[0] : record.state;
  if (candidate === "Deprecated" || candidate === "Disabled" || candidate === "Active") {
    return candidate;
  }
  return "Active";
}

async function readLifecycleEntry(
  contractId: string,
  functionName: string,
  address: string,
): Promise<IntegrationLifecycleState | null> {
  const rpcConfig = getStellarConfig();
  if (!assertAllowedRpcUrl(rpcConfig.sorobanRpcUrl)) return null;
  const gateway = new StellarRpcGateway();
  // A simulation source key only has to be valid — Soroban simulates without
  // submitting, so the key never needs funds.
  const sourceKey = env.ARENA_SIM_SOURCE_SECRET
    ? Keypair.fromSecret(env.ARENA_SIM_SOURCE_SECRET).publicKey()
    : Keypair.random().publicKey();
  const sourceAccount = await gateway.getAccount(
    sourceKey,
    `simulateViewCall.${functionName}`,
  );
  const contract = new Contract(contractId);
  const tx = new (await import("@stellar/stellar-sdk")).TransactionBuilder(sourceAccount, {
    fee: "100",
    networkPassphrase: rpcConfig.networkPassphrase,
  })
    // The gateway is shared with the frontend package, whose Stellar types
    // are a separate copy of the same library; the values are structurally
    // identical, so the boundary casts stay local to this call.
    .addOperation(contract.call(functionName, new Address(address).toScVal() as never))
    .setTimeout(60)
    .build();
  const result = await gateway.simulateTransaction(tx as never);
  if ("error" in result) return null;
  if (!result.result) return null;
  return decodeState(scValToNative(result.result.retval as never));
}

/**
 * Read the lifecycle of the requested integrations.
 *
 * An integration that cannot be read is absent from the map, which the
 * validator reads as "active".
 */
export async function readIntegrationLifecycle(input: {
  token?: string | undefined;
  vault?: string | undefined;
  oracle?: string | undefined;
}): Promise<IntegrationLifecycleMap> {
  const contractId = env.ARENA_FACTORY_CONTRACT_ID;
  const states: IntegrationLifecycleMap = {};
  if (!contractId) return states;

  const requested: Array<[keyof typeof LIFECYCLE_VIEW, string | undefined]> = [
    ["token", input.token],
    ["vault", input.vault],
    ["oracle", input.oracle],
  ];

  await Promise.all(
    requested.map(async ([kind, address]) => {
      if (!address) return;
      try {
        const state = await readLifecycleEntry(contractId, LIFECYCLE_VIEW[kind], address);
        if (state) states[`${kind}:${address}`] = state;
      } catch {
        // Unreadable: the integration stays absent from the map and is
        // validated as active.
      }
    }),
  );

  return states;
}
