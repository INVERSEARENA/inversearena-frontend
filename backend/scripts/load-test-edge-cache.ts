#!/usr/bin/env tsx
/**
 * scripts/load-test-edge-cache.ts — #1626
 *
 * Measures the origin-request reduction an edge cache achieves for anonymous
 * traffic on a public endpoint, using the backend's real `publicCache` policy.
 *
 * Why a simulation rather than an external load tool (k6/autocannon): the point
 * of the acceptance criterion is "does the Cache-Control policy with
 * stale-while-revalidate actually remove requests from the origin", not "how
 * many RPS can the box take". We can answer that exactly and reproducibly with
 * no external service:
 *
 *   1. Start an in-process Express app that mounts the real `publicCache`
 *      middleware and counts every request that reaches the origin handler.
 *   2. Drive it over real loopback HTTP with a shared cache in front that
 *      honours `Cache-Control: public, max-age, stale-while-revalidate`.
 *   3. Report origin RPS with the edge cache vs. with it disabled.
 *
 * The simulated cache implements RFC 9111 freshness: a response within
 * `max-age` is served fresh without touching the origin; within
 * `stale-while-revalidate` it is served immediately AND one background
 * revalidation is coalesced to the origin.
 *
 * Usage:
 *   npx tsx scripts/load-test-edge-cache.ts
 *   npx tsx scripts/load-test-edge-cache.ts --clients=200 --seconds=5
 */

import express from "express";
import http from "node:http";
import { publicCache } from "../src/middleware/cachePolicy";

interface Options {
  clients: number;
  seconds: number;
}

function parseOptions(argv: string[]): Options {
  const get = (name: string, fallback: number): number => {
    const arg = argv.find((a) => a.startsWith(`--${name}=`));
    if (!arg) return fallback;
    const value = Number(arg.split("=")[1]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return { clients: get("clients", 100), seconds: get("seconds", 3) };
}

interface CacheEntry {
  body: string;
  storedAt: number;
  maxAgeMs: number;
  swrMs: number;
}

function parseCacheControl(header: string | undefined): { maxAgeMs: number; swrMs: number } {
  const maxAge = /max-age=(\d+)/.exec(header ?? "");
  const swr = /stale-while-revalidate=(\d+)/.exec(header ?? "");
  return {
    maxAgeMs: maxAge ? Number(maxAge[1]) * 1000 : 0,
    swrMs: swr ? Number(swr[1]) * 1000 : 0,
  };
}

/**
 * A minimal shared cache. `enabled=false` models "no edge cache configured":
 * every client request reaches the origin.
 */
function createSharedCache(enabled: boolean, fetch: (path: string) => Promise<{ body: string; cacheControl?: string }>) {
  const store = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<void>>();

  async function originFetch(path: string): Promise<CacheEntry> {
    const { body, cacheControl } = await fetch(path);
    const { maxAgeMs, swrMs } = parseCacheControl(cacheControl);
    const entry: CacheEntry = { body, storedAt: Date.now(), maxAgeMs, swrMs };
    store.set(path, entry);
    return entry;
  }

  return async function get(path: string): Promise<string> {
    if (!enabled) {
      return (await originFetch(path)).body;
    }

    const entry = store.get(path);
    if (!entry) {
      return (await originFetch(path)).body;
    }

    const age = Date.now() - entry.storedAt;
    if (age < entry.maxAgeMs) {
      return entry.body; // fresh hit: origin not touched
    }
    if (age < entry.maxAgeMs + entry.swrMs) {
      // Stale but within SWR: serve immediately, coalesce one revalidation.
      if (!inFlight.has(path)) {
        const p = originFetch(path)
          .then(() => undefined)
          .finally(() => inFlight.delete(path));
        inFlight.set(path, p);
      }
      return entry.body;
    }
    return (await originFetch(path)).body; // fully stale: must revalidate
  };
}

async function runScenario(opts: Options, cacheEnabled: boolean): Promise<{ originRequests: number; clientRequests: number; rps: number }> {
  let originRequests = 0;

  const app = express();
  app.get(
    "/api/stats/landing",
    publicCache({ maxAge: 30, staleWhileRevalidate: 300 }),
    (_req, res) => {
      originRequests += 1;
      res.json({ totalArenas: 12, activeArenas: 4, totalPlayers: 350, totalYieldAccrued: 1234 });
    },
  );

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const originFetch = (path: string) =>
    new Promise<{ body: string; cacheControl?: string }>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path }, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () =>
            resolve({
              body,
              ...(res.headers["cache-control"] ? { cacheControl: res.headers["cache-control"] } : {}),
            }),
          );
        })
        .on("error", reject);
    });

  const cache = createSharedCache(cacheEnabled, originFetch);

  let clientRequests = 0;
  const started = Date.now();
  const deadline = started + opts.seconds * 1000;

  async function worker(): Promise<void> {
    while (Date.now() < deadline) {
      await cache("/api/stats/landing");
      clientRequests += 1;
    }
  }

  await Promise.all(Array.from({ length: opts.clients }, () => worker()));
  const elapsedSeconds = (Date.now() - started) / 1000;
  server.close();

  return {
    originRequests,
    clientRequests,
    rps: Math.round(clientRequests / elapsedSeconds),
  };
}

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));
  console.log(`Load test: ${opts.clients} concurrent clients for ${opts.seconds}s\n`);

  const noCache = await runScenario(opts, false);
  const withCache = await runScenario(opts, true);

  const reduction =
    noCache.originRequests > 0
      ? Math.round((1 - withCache.originRequests / noCache.originRequests) * 100)
      : 0;
  const originRpsNoCache = Math.round(noCache.originRequests / opts.seconds);
  const originRpsWithCache = Math.round(withCache.originRequests / opts.seconds);

  console.log("Scenario                          | Client RPS | Origin reqs | Origin RPS");
  console.log("----------------------------------|------------|-------------|-----------");
  console.log(
    `No edge cache (baseline)          | ${String(noCache.rps).padStart(10)} | ${String(noCache.originRequests).padStart(11)} | ${String(originRpsNoCache).padStart(10)}`,
  );
  console.log(
    `Edge cache (publicCache + SWR)    | ${String(withCache.rps).padStart(10)} | ${String(withCache.originRequests).padStart(11)} | ${String(originRpsWithCache).padStart(10)}`,
  );
  console.log(`\nOrigin-request reduction: ${reduction}%`);
  console.log(
    `Backend RPS reduction: ${originRpsNoCache} -> ${originRpsWithCache} (${originRpsNoCache - originRpsWithCache} fewer req/s)`,
  );

  if (reduction <= 0) {
    console.error("\nFAIL: edge cache did not reduce origin requests.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
