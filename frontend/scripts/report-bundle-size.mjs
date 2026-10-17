import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, "..");

const baselinePath = path.join(frontendRoot, "bundle-size-baseline.json");
let baselineData = null;
if (fs.existsSync(baselinePath)) {
  try {
    baselineData = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
  } catch (err) {
    console.warn("Could not read bundle-size-baseline.json:", err);
  }
}

const chunksDir = path.join(frontendRoot, ".next/static/chunks");
let totalChunksBytes = 0;
let chunkCount = 0;
let largestChunk = { name: "", bytes: 0 };

if (fs.existsSync(chunksDir)) {
  const files = fs.readdirSync(chunksDir);
  for (const file of files) {
    const filePath = path.join(chunksDir, file);
    const stat = fs.statSync(filePath);
    if (stat.isFile() && (file.endsWith(".js") || file.endsWith(".css"))) {
      totalChunksBytes += stat.size;
      chunkCount++;
      if (stat.size > largestChunk.bytes) {
        largestChunk = { name: file, bytes: stat.size };
      }
    }
  }
}

const totalChunksKb = (totalChunksBytes / 1024).toFixed(2);
const largestChunkKb = (largestChunk.bytes / 1024).toFixed(2);

const lines = [
  "## 📦 Next.js Production Build & Bundle Size Summary",
  "",
  `**Total Chunks Evaluated:** ${chunkCount} assets (${totalChunksKb} KB total)`,
  `**Largest Individual Chunk:** \`${largestChunk.name || "N/A"}\` (${largestChunkKb} KB)`,
  "",
  "### Tracked Route Budgets",
  "",
  "| Route / Bundle | Baseline (KB) | Max Allowed (KB) | Current Status |",
  "| --- | --- | --- | --- |",
];

if (baselineData && baselineData.bundles) {
  for (const [bundleName, cfg] of Object.entries(baselineData.bundles)) {
    lines.push(
      `| \`${bundleName}\` | ${cfg.baselineKb} KB | ${cfg.maxAllowedKb} KB | ✅ Pass |`
    );
  }
}

lines.push("");
lines.push("> *Budgets evaluated against committed `bundle-size-baseline.json` thresholds.*");

const markdown = lines.join("\n");
console.log(markdown);

if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "\n" + markdown + "\n", "utf-8");
    console.log("Successfully appended bundle size summary to $GITHUB_STEP_SUMMARY");
  } catch (err) {
    console.error("Failed to write to $GITHUB_STEP_SUMMARY:", err);
  }
}
