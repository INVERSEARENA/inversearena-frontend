import { DatasetExportWorker, type SettlementRecord } from "../workers/datasetExportWorker";

describe("DatasetExportWorker", () => {
  const tmpDir = "/tmp/test-datasets-" + Date.now();

  it("generates deterministic CSV output", () => {
    const worker = new DatasetExportWorker(tmpDir);
    const records: SettlementRecord[] = [
      {
        contractId: "CABC123",
        ledger: 100001,
        txHash: "deadbeef",
        settledAt: "2024-11-01T00:00:00Z",
        winnerWallet: "GABC456",
        payoutAmount: "10000000",
        asset: "XLM",
      },
    ];

    const csv1 = worker.generateCsv(records);
    const csv2 = worker.generateCsv(records);

    expect(csv1).toBe(csv2);
    expect(csv1).toContain("contract_id,ledger,tx_hash,settled_at,winner_wallet,payout_amount,asset");
    expect(csv1).toContain("CABC123,100001,deadbeef");
    expect(csv1).not.toContain("alias");
    expect(csv1).not.toContain("email");
  });

  it("produces a manifest with sha256 and row count", async () => {
    const worker = new DatasetExportWorker(tmpDir);
    const records: SettlementRecord[] = [
      {
        contractId: "CXYZ",
        ledger: 200,
        txHash: "aabb",
        settledAt: "2024-11-02T00:00:00Z",
        winnerWallet: "GWALLET",
        payoutAmount: "5000000",
        asset: "USDC",
      },
    ];

    const manifest = await worker.exportNightlyBatch("2024-11-02", records);

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.settlementDate).toBe("2024-11-02");
    expect(manifest.files.arenas.rowCount).toBe(1);
    expect(manifest.files.arenas.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
