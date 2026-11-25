import { z } from "zod";
import type { EnvVarSpec } from "../envSpec";
import { accountId, contractId, csv, decimal, flag, int, isoTimestamp, kid, rateLimit, rotation, secretSeed, text, url } from "../envSpec";

export const edgeCacheEnvVars = {
  FRONTEND_ORIGIN: {
    section: "Edge cache / revalidation",
    description:
      "Frontend origin the backend notifies when on-chain configuration changes, so its ISR caches revalidate (#1626). Falls back to PUBLIC_WEB_ORIGIN when unset.",
    schema: url,
  },
  REVALIDATION_WEBHOOK_SECRET: {
    section: "Edge cache / revalidation",
    description:
      "Shared HMAC secret for the frontend /api/revalidate webhook, at least 16 characters. When unset, on-chain changes still purge backend caches but the frontend is not notified.",
    secret: true,
    schema: text,
  },
  LANDING_STATS_CACHE_MAX_AGE_SECONDS: {
    section: "Edge cache / revalidation",
    description:
      "Edge Cache-Control max-age for GET /api/stats/landing (#1626). Keep below the frontend ISR revalidate window (60s).",
    default: "30",
    schema: int(1, 3600),
  },
  LANDING_STATS_STALE_WHILE_REVALIDATE_SECONDS: {
    section: "Edge cache / revalidation",
    description:
      "How long an edge cache may serve stale landing stats while revalidating in the background (#1626).",
    default: "300",
    schema: int(1, 86_400),
  }
} satisfies Record<string, EnvVarSpec>;
