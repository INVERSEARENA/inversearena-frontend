/**
 * Batched Soroban `getLedgerEntries` reader for hot arena state (#1768).
 *
 * Well-known keys are encoded from contract/fixtures/storage-layout/arena-keys.json.
 * A layout-version mismatch or a value that does not decode falls back to
 * simulation. An archived entry (liveUntilLedgerSeq already passed) does too:
 * the entry needs a restore, and simulation reports the live contract result.
 */

import fs from "node:fs";
import path from "node:path";
import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";

export const LEDGER_ENTRY_BATCH_LIMIT = 200;
export const STORAGE_LAYOUT_VERSION = 1;

export class LedgerLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerLayoutError";
  }
}

interface LayoutKey {
  name: string;
  durability: "persistent" | "temporary";
  encoding: "symbol" | "enum-unit" | "enum-address";
  symbol?: string;
  symbols?: string[];
}

interface LayoutFile {
  version: number;
  keys: LayoutKey[];
}

export interface LedgerEntrySource {
  getLedgerEntries(keys: xdr.LedgerKey[]): Promise<{
    entries: Array<{ key?: string; xdr: string; liveUntilLedgerSeq?: number | string }>;
  }>;
}

let cachedLayout: LayoutFile | null = null;

export function loadArenaStorageLayout(): LayoutFile {
  if (cachedLayout) return cachedLayout;
  const file = path.resolve(
    __dirname,
    "../../../contract/fixtures/storage-layout/arena-keys.json",
  );
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as LayoutFile;
  if (parsed.version !== STORAGE_LAYOUT_VERSION) {
    throw new LedgerLayoutError(
      `storage layout version ${parsed.version} does not match reader ${STORAGE_LAYOUT_VERSION}`,
    );
  }
  cachedLayout = parsed;
  return parsed;
}

export function encodeSymbol(name: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(name);
}

export function encodeEnumUnit(symbols: string[]): xdr.ScVal {
  return xdr.ScVal.scvVec(symbols.map((symbol) => xdr.ScVal.scvSymbol(symbol)));
}

export function encodeLayoutKey(spec: LayoutKey, contractId: string, address?: string): xdr.ScVal {
  if (spec.encoding === "symbol") {
    if (!spec.symbol) throw new LedgerLayoutError(`key ${spec.name} is missing its symbol`);
    return encodeSymbol(spec.symbol);
  }
  if (spec.encoding === "enum-unit") {
    if (!spec.symbols?.length) throw new LedgerLayoutError(`key ${spec.name} is missing its symbols`);
    return encodeEnumUnit(spec.symbols);
  }
  if (!address) throw new LedgerLayoutError(`key ${spec.name} needs a player address`);
  const symbols = spec.symbols ?? [];
  return xdr.ScVal.scvVec([
    ...symbols.map((symbol) => xdr.ScVal.scvSymbol(symbol)),
    new Address(address).toScVal(),
  ]);
}

export function contractDataLedgerKey(
  contractId: string,
  key: xdr.ScVal,
  durability: "persistent" | "temporary",
): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contractId).toScAddress(),
      key,
      durability:
        durability === "temporary"
          ? xdr.ContractDataDurability.temporary()
          : xdr.ContractDataDurability.persistent(),
    }),
  );
}

export function chunkKeys<T>(keys: T[], limit = LEDGER_ENTRY_BATCH_LIMIT): T[][] {
  if (limit < 1) throw new LedgerLayoutError("batch limit must be positive");
  const batches: T[][] = [];
  for (let i = 0; i < keys.length; i += limit) batches.push(keys.slice(i, i + limit));
  return batches;
}

function decodeEntry(xdrBase64: string, nowLedger?: number, liveUntil?: number): unknown {
  if (liveUntil !== undefined && nowLedger !== undefined && liveUntil < nowLedger) {
    throw new LedgerLayoutError("ledger entry is archived and needs a restore");
  }
  const data = xdr.LedgerEntryData.fromXDR(xdrBase64, "base64");
  return scValToNative(data.contractData().val());
}

export interface HotReadResult {
  kind: "value" | "miss";
  values: Record<string, unknown>;
}

/**
 * Read the fixture's persistent keys in batches of {@link LEDGER_ENTRY_BATCH_LIMIT}.
 * `kind: "miss"` means the RPC returned nothing decodable, so the caller
 * should simulate. A version or decode problem throws {@link LedgerLayoutError}
 * and the caller should simulate as well.
 */
export async function readArenaHotState(
  source: LedgerEntrySource,
  contractId: string,
  nowLedger?: number,
): Promise<HotReadResult> {
  const layout = loadArenaStorageLayout();
  const specs = layout.keys.filter((key) => key.encoding !== "enum-address");
  const ledgerKeys = specs.map((spec) =>
    contractDataLedgerKey(contractId, encodeLayoutKey(spec, contractId), spec.durability),
  );
  const values: Record<string, unknown> = {};
  let sawEntry = false;
  let offset = 0;
  for (const batch of chunkKeys(ledgerKeys)) {
    const response = await source.getLedgerEntries(batch);
    for (const [index, entry] of response.entries.entries()) {
      if (!entry?.xdr) continue;
      const byKey = entry.key
        ? specs.findIndex((spec, specIndex) => ledgerKeys[specIndex]?.toXDR("base64") === entry.key)
        : offset + index;
      const spec = specs[byKey];
      if (!spec) continue;
      sawEntry = true;
      const liveUntil =
        entry.liveUntilLedgerSeq === undefined ? undefined : Number(entry.liveUntilLedgerSeq);
      values[spec.name] = decodeEntry(entry.xdr, nowLedger, liveUntil);
    }
    offset += batch.length;
  }
  if (!sawEntry) return { kind: "miss", values };
  return { kind: "value", values };
}

export async function readArenaHotStateOrSimulate<T>(
  source: LedgerEntrySource,
  contractId: string,
  simulate: () => Promise<T>,
  project: (values: Record<string, unknown>) => T | undefined,
  nowLedger?: number,
): Promise<T> {
  try {
    const read = await readArenaHotState(source, contractId, nowLedger);
    if (read.kind === "value") {
      const projected = project(read.values);
      if (projected !== undefined) return projected;
    }
  } catch (error) {
    if (!(error instanceof LedgerLayoutError) && !(error instanceof Error)) {
      throw error;
    }
  }
  return simulate();
}
