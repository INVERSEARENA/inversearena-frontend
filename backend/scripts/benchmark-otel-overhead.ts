/**
 * Measures p50/p95/p99 HTTP request latency overhead of OpenTelemetry tracing
 * at 10% sampling vs. disabled (#1844).
 *
 * Spawns two isolated child processes so `NodeSDK` initializes before `http`
 * and `express` are loaded in the sampled run, ensuring real auto-instrumentation.
 *
 * Usage:
 *   pnpm --filter inversearena-backend exec tsx scripts/benchmark-otel-overhead.ts
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REQUEST_COUNT = 1000;
const WARMUP_COUNT = 100;

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

async function runSingleMode(enableTracing: boolean) {
  let exporter: import("@opentelemetry/sdk-trace-base").InMemorySpanExporter | undefined;
  let sdk: import("@opentelemetry/sdk-node").NodeSDK | undefined;

  if (enableTracing) {
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { HttpInstrumentation } = await import("@opentelemetry/instrumentation-http");
    const { ExpressInstrumentation } = await import("@opentelemetry/instrumentation-express");
    const {
      InMemorySpanExporter,
      ParentBasedSampler,
      BatchSpanProcessor,
      TraceIdRatioBasedSampler,
    } = await import("@opentelemetry/sdk-trace-base");

    exporter = new InMemorySpanExporter();
    sdk = new NodeSDK({
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(0.1) }),
      spanProcessors: [new BatchSpanProcessor(exporter)],
      instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
    });
    sdk.start();
  }

  const req = createRequire(import.meta.url);
  const express = req("express") as typeof import("express");
  const http = req("node:http") as typeof import("node:http");

  const app = express();
  app.get("/ping", (_req, res) => {
    res.json({ ok: true });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind benchmark server");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  for (let i = 0; i < WARMUP_COUNT; i++) {
    await fetch(`${baseUrl}/ping`);
  }

  const latenciesMs: number[] = [];
  for (let i = 0; i < REQUEST_COUNT; i++) {
    const start = process.hrtime.bigint();
    const res = await fetch(`${baseUrl}/ping`);
    await res.text();
    latenciesMs.push(Number(process.hrtime.bigint() - start) / 1_000_000);
  }

  if (sdk) {
    await (sdk as unknown as { _tracerProvider?: { forceFlush(): Promise<void> } })._tracerProvider?.forceFlush();
  }
  const recordedSpans = exporter ? exporter.getFinishedSpans().length : 0;
  if (sdk) await sdk.shutdown();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );

  latenciesMs.sort((a, b) => a - b);
  return {
    p50Ms: Number(percentile(latenciesMs, 50).toFixed(3)),
    p95Ms: Number(percentile(latenciesMs, 95).toFixed(3)),
    p99Ms: Number(percentile(latenciesMs, 99).toFixed(3)),
    recordedSpans,
  };
}

async function main() {
  const modeArg = process.argv.find((arg) => arg.startsWith("--mode="));
  if (modeArg === "--mode=off") {
    console.log(JSON.stringify(await runSingleMode(false)));
    return;
  }
  if (modeArg === "--mode=sampled") {
    console.log(JSON.stringify(await runSingleMode(true)));
    return;
  }

  const scriptPath = fileURLToPath(import.meta.url);
  const runChild = (mode: "off" | "sampled") => {
    const raw = execFileSync(process.execPath, ["--import", "tsx", scriptPath, `--mode=${mode}`], {
      encoding: "utf8",
    });
    return JSON.parse(raw.trim()) as {
      p50Ms: number;
      p95Ms: number;
      p99Ms: number;
      recordedSpans: number;
    };
  };

  const off = runChild("off");
  const sampling10Pct = runChild("sampled");
  const p99DeltaMs = Number((sampling10Pct.p99Ms - off.p99Ms).toFixed(3));
  const p99OverheadPct = off.p99Ms > 0 ? Number(((p99DeltaMs / off.p99Ms) * 100).toFixed(2)) : 0;

  console.log(
    JSON.stringify(
      {
        requests: REQUEST_COUNT,
        off,
        sampling10Pct,
        p99DeltaMs,
        p99OverheadPct,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
