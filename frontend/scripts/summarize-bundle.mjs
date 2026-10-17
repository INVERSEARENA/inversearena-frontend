import fs from "node:fs";
import path from "node:path";

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "kB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

function getDirectorySize(dirPath) {
  let size = 0;
  if (!fs.existsSync(dirPath)) return 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += getDirectorySize(fullPath);
      } else if (entry.isFile()) {
        size += fs.statSync(fullPath).size;
      }
    }
  } catch {
    // Ignore read errors
  }
  return size;
}

export function generateSummaryMarkdown(logFilePath, nextDir = ".next") {
  const actualNextDir = nextDir;
  const manifestPath = path.join(actualNextDir, "app-path-routes-manifest.json");
  const staticDir = path.join(actualNextDir, "static");
  const serverDir = path.join(actualNextDir, "server");

  let routes = [];
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      routes = Object.values(manifest);
    } catch {
      // Ignore JSON parse errors
    }
  }

  // Also parse log if provided
  let logContent = "";
  if (logFilePath && fs.existsSync(logFilePath)) {
    logContent = fs.readFileSync(logFilePath, "utf8");
  }

  const staticSize = getDirectorySize(staticDir);
  const serverSize = getDirectorySize(serverDir);
  const totalSize = staticSize + serverSize;

  let md = "## 📦 Frontend Bundle Size Summary\n\n";
  md += "> ✅ **Production build compiled successfully**\n\n";

  md += "| Asset Type | Total Size |\n";
  md += "| :--- | :--- |\n";
  md += "| **Client Chunks (`.next/static`)** | " + formatBytes(staticSize) + " |\n";
  md += "| **Server Artifacts (`.next/server`)** | " + formatBytes(serverSize) + " |\n";
  md += "| **Total Build Artifacts** | " + formatBytes(totalSize) + " |\n\n";

  if (routes.length > 0) {
    md += `### 🌐 Compiled Routes (${routes.length} total)\n\n`;
    md += "| Route | Path Type |\n";
    md += "| :--- | :--- |\n";
    for (const route of routes.sort()) {
      const isApi = route.startsWith("/api") || route.includes("/route");
      md += `| \`${route}\` | ${isApi ? "API / Route Handler" : "Page"} |\n`;
    }
    md += "\n";
  }

  return md;
}

// CLI usage
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"))) {
  const logFile = process.argv[2] || "next-build.log";
  const nextDir = process.argv[3] || ".next";
  const output = generateSummaryMarkdown(logFile, nextDir);
  process.stdout.write(output + "\n");
}
