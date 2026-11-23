import { xdr } from "@stellar/stellar-sdk";
import {
  LEDGER_ENTRY_BATCH_LIMIT,
  LedgerLayoutError,
  chunkKeys,
  contractDataLedgerKey,
  encodeEnumUnit,
  encodeLayoutKey,
  encodeSymbol,
  loadArenaStorageLayout,
  readArenaHotStateOrSimulate,
} from "../../src/services/ledgerEntryReader";

const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

describe("arena storage key codec (#1768)", () => {
  it("encodes every fixture key to a distinct ledger key", () => {
    const layout = loadArenaStorageLayout();
    expect(layout.version).toBe(1);
    const encoded = layout.keys.map((spec) =>
      contractDataLedgerKey(
        CONTRACT,
        encodeLayoutKey(
          spec,
          CONTRACT,
          spec.encoding === "enum-address" ? "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" : undefined,
        ),
        spec.durability,
      ).toXDR("base64"),
    );
    expect(new Set(encoded).size).toBe(layout.keys.length);
    expect(encodeSymbol("CONFIG").switch()).toBe(xdr.ScValType.scvSymbol());
    expect(encodeEnumUnit(["Winner"]).switch()).toBe(xdr.ScValType.scvVec());
  });

  it("batches at the RPC limit", () => {
    const keys = Array.from({ length: LEDGER_ENTRY_BATCH_LIMIT + 3 }, (_, i) => i);
    const batches = chunkKeys(keys);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(LEDGER_ENTRY_BATCH_LIMIT);
    expect(batches[1]).toHaveLength(3);
  });

  it("falls back to simulation when the layout version does not match", async () => {
    const simulate = jest.fn(async () => "simulated");
    const source = {
      getLedgerEntries: jest.fn(async () => {
        throw new LedgerLayoutError("version mismatch");
      }),
    };
    await expect(readArenaHotStateOrSimulate(source, CONTRACT, simulate, () => "ledger")).resolves.toBe("simulated");
    expect(simulate).toHaveBeenCalledTimes(1);
  });

  it("uses one batched read for the hot keys instead of one simulation per key", async () => {
    const layout = loadArenaStorageLayout();
    const hot = layout.keys.filter((key) => key.encoding !== "enum-address");
    const source = { getLedgerEntries: jest.fn(async () => ({ entries: [] })) };
    const simulate = jest.fn(async () => "simulated");
    await readArenaHotStateOrSimulate(source, CONTRACT, simulate, () => undefined);
    expect(source.getLedgerEntries).toHaveBeenCalledTimes(1);
    expect(source.getLedgerEntries.mock.calls[0][0]).toHaveLength(hot.length);
    expect(simulate).toHaveBeenCalledTimes(1);
  });
});
