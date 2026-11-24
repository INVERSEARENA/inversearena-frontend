import fs from "fs";
import path from "path";
import crypto from "crypto";

export interface DatasetManifestEntry {
  filename: string;
  rowCount: number;
  sha256: string;
  byteSize: number;
}

export interface DatasetManifest {
  schemaVersion: number;
  settlementDate: string;
  generatedAt: string;
  files: Record<string, DatasetManifestEntry>;
}

export interface SettlementRecord {
  contractId: string;
  ledger: number;
  txHash: string;
  settledAt: string;
  winnerWallet: string;
  payoutAmount: string;
  asset: string;
}

export class DatasetExportWorker {
  private exportDir: string;

  constructor(exportDir?: string) {
    this.exportDir = exportDir || path.resolve(process.cwd(), "public/datasets");
    if (!fs.existsSync(this.exportDir)) {
      fs.mkdirSync(this.exportDir, { recursive: true });
    }
  }

  generateCsv(records: SettlementRecord[]): string {
    const headers = ["contract_id", "ledger", "tx_hash", "settled_at", "winner_wallet", "payout_amount", "asset"];
    const rows = records.map((r) => [
      r.contractId,
      r.ledger,
      r.txHash,
      r.settledAt,
      r.winnerWallet,
      r.payoutAmount,
      r.asset,
    ].join(","));
    return [headers.join(","), ...rows].join("\n");
  }

  async exportNightlyBatch(settlementDate: string, records: SettlementRecord[]): Promise<DatasetManifest> {
    const csvContent = this.generateCsv(records);
    const filename = `settled_arenas_${settlementDate}.csv`;
    const filePath = path.join(this.exportDir, filename);

    fs.writeFileSync(filePath, csvContent, "utf-8");

    const sha256 = crypto.createHash("sha256").update(csvContent).digest("hex");
    const stat = fs.statSync(filePath);

    const manifest: DatasetManifest = {
      schemaVersion: 1,
      settlementDate,
      generatedAt: new Date().toISOString(),
      files: {
        arenas: {
          filename,
          rowCount: records.length,
          sha256,
          byteSize: stat.size,
        },
      },
    };

    const manifestPath = path.join(this.exportDir, `manifest_${settlementDate}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    return manifest;
  }
}
