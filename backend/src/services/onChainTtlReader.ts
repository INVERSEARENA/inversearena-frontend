/**
 * Read-only RPC access to contract-entry TTL headroom (#1516).
 *
 * A Soroban contract cannot read its own entry TTL (the SDK only exposes that
 * to the test host), so TTL observation is inherently an off-chain concern.
 * This adapter wraps the raw RPC `getLedgerEntries` call, which returns each
 * entry's `liveUntilLedgerSeq`, and is deliberately the *only* module in the
 * keeper that talks to RPC — everything above it (`ttlKeeperPlan.ts`,
 * `ttlKeeperService.ts`) takes an injected `RpcTtlReader` and stays pure.
 *
 * It is intentionally separate from `StellarRpcGateway` (a frontend service
 * built for cached simulations); the keeper is a background job that wants a
 * raw, uncached ledger read rather than the request-path optimisations.
 *
 * @module
 */

import { Contract, xdr, rpc } from "@stellar/stellar-sdk";
import {
  assertAllowedRpcUrl,
  getStellarConfig,
} from "../config/stellarConfig";

export interface KeyTtl {
  /** Whether the entry currently exists on-chain. */
  present: boolean;
  /** `liveUntilLedgerSeq`, or null when absent/unreadable. */
  liveUntilLedger: number | null;
}

/**
 * The minimal RPC surface the keeper needs. Injected so the keeper is
 * testable without a network.
 */
export interface RpcTtlReader {
  getLatestLedger(): Promise<number>;
  getNetworkPassphrase(): Promise<string>;
  getKeyTtl(contractId: string, key: string): Promise<KeyTtl>;
}

/**
 * Build a `LedgerKey` for a persistent contract-data entry keyed by a symbol.
 * Exported for unit testing of the encoding.
 */
export function contractDataLedgerKey(contractId: string, key: string): xdr.LedgerKey {
  const contract = new Contract(contractId);
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contract.address().toScAddress(),
      key: xdr.ScVal.scvSymbol(key),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/**
 * Default reader backed by a real Soroban RPC server. Accepts an optional
 * pre-built `rpc.Server` (test seam); otherwise builds one from config.
 */
export function createRpcTtlReader(server?: rpc.Server): RpcTtlReader {
  const config = getStellarConfig();
  if (!assertAllowedRpcUrl(config.sorobanRpcUrl)) {
    throw new Error("SOROBAN_RPC_URL is not permitted");
  }
  const client = server ?? new rpc.Server(config.sorobanRpcUrl);

  return {
    async getLatestLedger(): Promise<number> {
      const response = await client.getLatestLedger();
      return response.sequence;
    },

    async getNetworkPassphrase(): Promise<string> {
      const response = await client.getNetwork();
      return response.passphrase;
    },

    async getKeyTtl(contractId: string, key: string): Promise<KeyTtl> {
      const ledgerKey = contractDataLedgerKey(contractId, key);
      const response = await client.getLedgerEntries(ledgerKey);
      const entry = response.entries[0];
      if (!entry || entry.liveUntilLedgerSeq === undefined) {
        return { present: false, liveUntilLedger: null };
      }
      return { present: true, liveUntilLedger: entry.liveUntilLedgerSeq };
    },
  };
}
