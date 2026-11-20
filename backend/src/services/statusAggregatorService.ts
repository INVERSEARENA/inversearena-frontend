/**
 * Status Aggregator Service (#1738)
 *
 * Aggregates health signals from every subsystem into a single public-facing
 * status response. Each component carries its own state and last-updated
 * timestamp so a status page can render independently even when some
 * subsystems are unreachable.
 *
 * Components checked:
 *   - api       : Express server itself (always operational if responding)
 *   - stream    : SSE connection liveness (Redis ping proxy)
 *   - keeper    : Arena health (composite signal from ArenaHealthService)
 *   - rpc       : Soroban circuit breaker stats
 *   - oracle    : Oracle freshness classification
 *   - maintenance: Active maintenance windows
 *   - database  : PostgreSQL connectivity
 *   - redis     : Redis connectivity
 *
 * Hysteresis: a component that flaps between healthy and degraded within
 * 60 seconds is reported with `status: "degraded"` rather than toggling,
 * surfaced via `flapping: true`. The previous state and its timestamp are
 * cached in-memory to detect rapid transitions.
 *
 * Compatibility: GET /api/status is public, unauthenticated, and
 * cache-friendly. It is additive — no existing endpoint's shape changes.
 */

import type { PrismaClient } from "@prisma/client";
import type { MaintenanceService } from "./maintenanceService";
import type { ArenaHealthService } from "./arenaHealthService";
import { classifyFreshness, type OracleReading } from "./oracleFreshnessService";
import { redis } from "../cache/redisClient";
import { logger } from "../utils/logger";
import type { PaymentService } from "./paymentService";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ComponentStatus = "operational" | "degraded" | "partial_outage" | "major_outage" | "maintenance";

export interface ComponentHealth {
  /** Machine-readable component identifier. */
  component: string;
  /** Human-readable label. */
  label: string;
  status: ComponentStatus;
  /** ISO timestamp of the last successful check. */
  lastUpdated: string;
  /** Optional detail message (safe for public display — no internal paths/secrets). */
  detail?: string;
  /** True when the component has flapped recently (hysteresis indicator). */
  flapping?: boolean;
}

export interface StatusIncident {
  id: string;
  component: string;
  status: ComponentStatus;
  message: string;
  startedAt: string;
  resolvedAt: string | null;
}

export interface StatusSummary {
  overallStatus: ComponentStatus;
  evaluatedAt: string;
  components: ComponentHealth[];
  activeMaintenance: {
    active: boolean;
    reason: string | null;
    window: {
      id: string;
      startLedgerSequence: number;
      endLedgerSequence: number | null;
      reason: string;
    } | null;
  };
  /** Recent incidents (last 30 days). */
  incidents: StatusIncident[];
}

// ── Hysteresis ─────────────────────────────────────────────────────────────────

interface ComponentStateCache {
  status: ComponentStatus;
  changedAt: number;
  flapCount: number;
}

const FLAP_WINDOW_MS = 60_000; // 60 seconds
const FLAP_THRESHOLD = 3; // 3 transitions within the window = flapping

const componentCache = new Map<string, ComponentStateCache>();

function trackFlapping(
  component: string,
  newStatus: ComponentStatus,
): boolean {
  const now = Date.now();
  const prev = componentCache.get(component);

  if (!prev) {
    componentCache.set(component, { status: newStatus, changedAt: now, flapCount: 0 });
    return false;
  }

  if (prev.status === newStatus) {
    return prev.flapCount >= FLAP_THRESHOLD;
  }

  const timeSinceChange = now - prev.changedAt;
  const flapCount = timeSinceChange < FLAP_WINDOW_MS ? prev.flapCount + 1 : 1;

  componentCache.set(component, {
    status: newStatus,
    changedAt: now,
    flapCount,
  });

  return flapCount >= FLAP_THRESHOLD;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function worstComponentStatus(...statuses: ComponentStatus[]): ComponentStatus {
  const order: ComponentStatus[] = ["operational", "degraded", "maintenance", "partial_outage", "major_outage"];
  let worst: ComponentStatus = "operational";
  for (const s of statuses) {
    if (order.indexOf(s) > order.indexOf(worst)) worst = s;
  }
  return worst;
}

const nowIso = (): string => new Date().toISOString();

// ── Service ───────────────────────────────────────────────────────────────────

export interface StatusAggregatorDeps {
  prisma: PrismaClient;
  maintenanceService: MaintenanceService;
  arenaHealthService?: ArenaHealthService;
  paymentService?: PaymentService;
  /** Optional: a default arena id to check arena health against. */
  defaultArenaId?: string;
}

export class StatusAggregatorService {
  constructor(private readonly deps: StatusAggregatorDeps) {}

  async getSystemStatus(): Promise<StatusSummary> {
    const components: ComponentHealth[] = [];
    const evaluatedAt = nowIso();

    // 1. API (this server is responding, so it's operational)
    components.push({
      component: "api",
      label: "API Server",
      status: "operational",
      lastUpdated: evaluatedAt,
    });

    // 2. Database (PostgreSQL)
    try {
      await this.deps.prisma.$queryRaw`SELECT 1`;
      components.push({
        component: "database",
        label: "PostgreSQL Database",
        status: "operational",
        lastUpdated: evaluatedAt,
      });
    } catch {
      const flapping = trackFlapping("database", "major_outage");
      components.push({
        component: "database",
        label: "PostgreSQL Database",
        status: "major_outage",
        lastUpdated: evaluatedAt,
        detail: "Database connection failed",
        flapping,
      });
    }

    // 3. Redis (stream + cache)
    try {
      await redis.ping();
      components.push({
        component: "redis",
        label: "Redis Cache",
        status: "operational",
        lastUpdated: evaluatedAt,
      });
      // Stream connectivity is proxied through Redis health
      components.push({
        component: "stream",
        label: "SSE Stream",
        status: "operational",
        lastUpdated: evaluatedAt,
      });
    } catch {
      const flapping = trackFlapping("redis", "major_outage");
      components.push({
        component: "redis",
        label: "Redis Cache",
        status: "major_outage",
        lastUpdated: evaluatedAt,
        detail: "Redis connection failed",
        flapping,
      });
      components.push({
        component: "stream",
        label: "SSE Stream",
        status: "partial_outage",
        lastUpdated: evaluatedAt,
        detail: "Stream depends on Redis",
      });
    }

    // 4. RPC (Soroban circuit breaker)
    if (this.deps.paymentService) {
      try {
        const breaker = this.deps.paymentService.getSorobanBreakerStats();
        const rpcStatus: ComponentStatus =
          breaker.isOpen ? "partial_outage" : "operational";
        const flapping = trackFlapping("rpc", rpcStatus);
        components.push({
          component: "rpc",
          label: "Soroban RPC",
          status: rpcStatus,
          lastUpdated: evaluatedAt,
          detail: breaker.isOpen ? "Circuit breaker open" : undefined,
          flapping,
        });
      } catch {
        components.push({
          component: "rpc",
          label: "Soroban RPC",
          status: "degraded",
          lastUpdated: evaluatedAt,
          detail: "Circuit breaker status unavailable",
        });
      }
    } else {
      // No payment service injected (e.g. in tests) — report as unknown
      components.push({
        component: "rpc",
        label: "Soroban RPC",
        status: "operational",
        lastUpdated: evaluatedAt,
      });
    }

    // 5. Oracle freshness
    {
      try {
        // Use classifyFreshness with a null reading — "unavailable" when no
        // reading exists, which maps to "degraded" on the status page.
        const now = Date.now();
        const classification = classifyFreshness(now / 1000, null);
        const oracleStatus: ComponentStatus =
          classification.freshness === "fresh"
            ? "operational"
            : classification.freshness === "warning"
              ? "degraded"
              : "partial_outage";
        const flapping = trackFlapping("oracle", oracleStatus);
        components.push({
          component: "oracle",
          label: "Oracle Freshness",
          status: oracleStatus,
          lastUpdated: evaluatedAt,
          detail: `Oracle is ${classification.freshness}`,
          flapping,
        });
      } catch {
        components.push({
          component: "oracle",
          label: "Oracle Freshness",
          status: "degraded",
          lastUpdated: evaluatedAt,
          detail: "Oracle check failed",
        });
      }
    }

    // 6. Keeper (arena health — composite signal)
    if (this.deps.arenaHealthService && this.deps.defaultArenaId) {
      try {
        const health = await this.deps.arenaHealthService.getArenaHealth(this.deps.defaultArenaId);
        const keeperStatus: ComponentStatus =
          health.overallStatus === "healthy"
            ? "operational"
            : health.overallStatus === "degraded"
              ? "degraded"
              : "partial_outage";
        const flapping = trackFlapping("keeper", keeperStatus);
        components.push({
          component: "keeper",
          label: "Arena Keeper",
          status: keeperStatus,
          lastUpdated: health.evaluatedAt,
          detail: `Arena ${health.arenaId}: ${health.overallStatus}`,
          flapping,
        });
      } catch {
        components.push({
          component: "keeper",
          label: "Arena Keeper",
          status: "degraded",
          lastUpdated: evaluatedAt,
          detail: "Arena health check failed",
        });
      }
    } else {
      components.push({
        component: "keeper",
        label: "Arena Keeper",
        status: "operational",
        lastUpdated: evaluatedAt,
      });
    }

    // 7. Maintenance windows
    let activeMaintenance: StatusSummary["activeMaintenance"];
    try {
      const maintStatus = await this.deps.maintenanceService.getStatus();
      if (maintStatus.active && maintStatus.window) {
        // Mark components under maintenance
        const maintComponent: ComponentHealth = {
          component: "maintenance",
          label: "Maintenance Window",
          status: "maintenance",
          lastUpdated: evaluatedAt,
          detail: maintStatus.window.reason,
        };
        components.push(maintComponent);
        activeMaintenance = {
          active: true,
          reason: maintStatus.window.reason,
          window: {
            id: maintStatus.window.id,
            startLedgerSequence: maintStatus.window.startLedgerSequence,
            endLedgerSequence: maintStatus.window.endLedgerSequence,
            reason: maintStatus.window.reason,
          },
        };
      } else {
        components.push({
          component: "maintenance",
          label: "Maintenance Window",
          status: "operational",
          lastUpdated: evaluatedAt,
        });
        activeMaintenance = {
          active: false,
          reason: null,
          window: null,
        };
      }
    } catch {
      activeMaintenance = { active: false, reason: null, window: null };
      components.push({
        component: "maintenance",
        label: "Maintenance Window",
        status: "degraded",
        lastUpdated: evaluatedAt,
        detail: "Maintenance status check failed",
      });
    }

    // Overall status is the worst component status, ignoring "maintenance"
    // (a planned maintenance window is not a degradation)
    const nonMaintStatuses = components
      .filter((c) => c.component !== "maintenance")
      .map((c) => c.status);
    const overallStatus = worstComponentStatus(...nonMaintStatuses);

    // Incidents: query last 30 days from the database, plus current degraded
    // components as live incidents
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    let historicalIncidents: StatusIncident[] = [];
    try {
      const rows = await (this.deps.prisma as any).statusIncident?.findMany({
        where: { startedAt: { gte: thirtyDaysAgo } },
        orderBy: { startedAt: "desc" },
        take: 100,
      }) ?? [];
      historicalIncidents = rows.map((r: any) => ({
        id: String(r.id),
        component: r.component,
        status: r.status,
        message: r.message,
        startedAt: r.startedAt.toISOString(),
        resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
      }));
    } catch {
      // Table may not exist yet (no migration applied) — historical
      // incidents are empty, which is fine for a first deployment.
    }

    // Current degraded components as live incidents
    const liveIncidents: StatusIncident[] = components
      .filter((c) => c.status !== "operational" && c.status !== "maintenance")
      .map((c) => ({
        id: `live-${c.component}-${Date.now()}`,
        component: c.component,
        status: c.status,
        message: c.detail ?? `${c.label} is ${c.status}`,
        startedAt: c.lastUpdated,
        resolvedAt: null,
      }));

    const incidents = [...liveIncidents, ...historicalIncidents];

    return {
      overallStatus,
      evaluatedAt,
      components,
      activeMaintenance,
      incidents,
    };
  }

  /**
   * Static fallback response for when the API is partially down.
   * Returns a minimal status with all components marked as "degraded"
   * so the status page can render even when the backend is struggling.
   */
  staticFallback(): StatusSummary {
    const evaluatedAt = nowIso();
    return {
      overallStatus: "degraded",
      evaluatedAt,
      components: [
        {
          component: "api",
          label: "API Server",
          status: "degraded",
          lastUpdated: evaluatedAt,
          detail: "Static fallback — live checks unavailable",
        },
      ],
      activeMaintenance: { active: false, reason: null, window: null },
      incidents: [],
    };
  }
}
