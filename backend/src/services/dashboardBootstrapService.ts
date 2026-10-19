/**
 * Dashboard bootstrap composer (#1501).
 *
 * GET /api/dashboard/bootstrap returns the wallet-scoped dashboard payload in
 * one round trip. Every section is read from the existing authorized service
 * that already backs its source endpoint — no section re-implements a domain
 * query:
 *
 *   profile        → userProfileService.getUserProfileSummary  (GET /api/users/me)
 *   watchlist      → WatchlistService.list                     (GET /api/users/me/watchlist)
 *   portfolio      → PortfolioExposureService.getPortfolioExposure (GET /api/users/me/portfolio)
 *   notifications  → NotificationPreferencesService.getPreferences  (GET /api/users/me/notifications)
 *   platform       → MaintenanceService.getStatus              (GET /api/maintenance/status)
 *
 * Sections run concurrently under a per-section timeout and are reported
 * independently as `ok`, `unavailable`, or `stale` so one slow dependency
 * (typically the ledger RPC behind the platform section) never blocks the
 * rest of the dashboard. `stale` means the fresh read failed or timed out but
 * a recent cached read for the *same principal* exists — wallet-private
 * entries are keyed by userId and never shared across principals; the
 * platform section is public and keyed globally.
 */

import { createHash, randomUUID } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { WatchlistService } from "./watchlistService";
import { PortfolioExposureService, type PortfolioExposure } from "./portfolioExposureService";
import { NotificationPreferencesService, type NotificationPreferences } from "./notificationPreferencesService";
import { MaintenanceService, type MaintenanceStatusView } from "./maintenanceService";
import { getUserProfileSummary, type ProfileSummary } from "./userProfileService";
import { getCurrentLedgerSequence } from "./ledgerClock";
import { issueSignedServerTime } from "./serverTimeService";
import { getStellarConfig } from "../config/stellarConfig";
import {
  dashboardBootstrapTotal,
  dashboardBootstrapSectionDuration,
  dashboardBootstrapSectionFailures,
} from "../utils/metrics";

export type SectionState = "ok" | "unavailable" | "stale";

export interface BootstrapSection<T> {
  state: SectionState;
  data: T | null;
  etag: string;
  latencyMs: number;
  /** Populated for `stale`/`unavailable` — never contains user input. */
  error?: { reason: "timeout" | "error"; code: string; message: string };
}

export interface DashboardBootstrapResponse {
  version: 1;
  requestId: string;
  /** Signed server-time token; null when the JWT keyring is unavailable. */
  serverTime: { serverTimeMs: number; issuedAt: string; token: string } | null;
  serverTimeError?: string;
  /** Hash of the protocol configuration this payload was built against. */
  configRevision: string;
  /** Current ledger sequence; null when the RPC is unreachable (degraded). */
  ledgerSequence: number | null;
  generatedAtMs: number;
  outcome: "ok" | "partial";
  sections: {
    profile: BootstrapSection<ProfileSummary>;
    watchlist: BootstrapSection<{ watchedArenaIds: string[] }>;
    portfolio: BootstrapSection<PortfolioExposure>;
    notifications: BootstrapSection<NotificationPreferences>;
    platform: BootstrapSection<MaintenanceStatusView>;
  };
}

export type SectionName = keyof DashboardBootstrapResponse["sections"];

/** Per-section timeout — a slow dependency must not block sibling sections. */
export const SECTION_TIMEOUT_MS = 700;
/** How long a successful section read may serve `stale` after a failed refresh. */
export const SECTION_CACHE_TTL_MS = 30_000;

class SectionTimeoutError extends Error {
  constructor() {
    super(`section timed out after ${SECTION_TIMEOUT_MS}ms`);
    this.name = "SectionTimeoutError";
  }
}

interface CachedSection {
  data: unknown;
  etag: string;
  cachedAt: number;
}

/**
 * Process-local section cache. Keys are `userId:section` for wallet-private
 * sections and `public:section` for the platform section, so a wallet's data
 * can never be served to another principal.
 */
const sectionCache = new Map<string, CachedSection>();

export function resetSectionCacheForTest(): void {
  sectionCache.clear();
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SectionTimeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function generateETag(serialized: string): string {
  return `"${createHash("sha1").update(serialized).digest("hex").slice(0, 20)}"`;
}

function toSection<T>(
  section: SectionName,
  cacheKey: string,
  start: number,
  result: PromiseSettledResult<T>,
): BootstrapSection<T> {
  const latencyMs = Date.now() - start;

  if (result.status === "fulfilled") {
    const etag = generateETag(JSON.stringify(result.value));
    sectionCache.set(cacheKey, { data: result.value, etag, cachedAt: Date.now() });
    dashboardBootstrapSectionDuration.observe({ section, state: "ok" }, latencyMs / 1000);
    return { state: "ok", data: result.value, etag, latencyMs };
  }

  const error = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
  const isTimeout = error instanceof SectionTimeoutError;
  const reason = isTimeout ? "timeout" : "error";
  dashboardBootstrapSectionFailures.inc({ section, reason });

  const cached = sectionCache.get(cacheKey);
  const fresh = cached && Date.now() - cached.cachedAt <= SECTION_CACHE_TTL_MS;

  if (fresh && cached) {
    dashboardBootstrapSectionDuration.observe({ section, state: "stale" }, latencyMs / 1000);
    return {
      state: "stale",
      data: cached.data as T,
      etag: cached.etag,
      latencyMs,
      error: {
        reason,
        code: isTimeout ? "SECTION_TIMEOUT" : "SECTION_ERROR",
        message: error.message,
      },
    };
  }

  dashboardBootstrapSectionDuration.observe({ section, state: "unavailable" }, latencyMs / 1000);
  return {
    state: "unavailable",
    data: null,
    etag: generateETag(`unavailable:${cacheKey}:${Date.now()}`),
    latencyMs,
    error: {
      reason,
      code: isTimeout ? "SECTION_TIMEOUT" : "SECTION_ERROR",
      message: error.message,
    },
  };
}

/** Stable revision of the protocol configuration this payload was built with. */
function computeConfigRevision(): string {
  try {
    const stellar = getStellarConfig();
    return createHash("sha256")
      .update(
        JSON.stringify({
          sorobanRpcUrl: stellar.sorobanRpcUrl,
          networkPassphrase: stellar.networkPassphrase,
          roundConfirmPollMs: stellar.roundConfirmPollMs,
          roundConfirmMaxPolls: stellar.roundConfirmMaxPolls,
        }),
      )
      .digest("hex")
      .slice(0, 16);
  } catch {
    return "unconfigured";
  }
}

export class DashboardBootstrapService {
  private readonly watchlistService: WatchlistService;
  private readonly portfolioService: PortfolioExposureService;
  private readonly notificationsService: NotificationPreferencesService;
  private readonly maintenanceService: MaintenanceService;

  constructor(private readonly prisma: PrismaClient) {
    this.watchlistService = new WatchlistService(prisma);
    this.portfolioService = new PortfolioExposureService(prisma);
    this.notificationsService = new NotificationPreferencesService(prisma);
    this.maintenanceService = new MaintenanceService();
  }

  async compose(userId: string): Promise<DashboardBootstrapResponse> {
    const requestId = randomUUID();
    const generatedAtMs = Date.now();

    let serverTime: DashboardBootstrapResponse["serverTime"] = null;
    let serverTimeError: string | undefined;
    try {
      serverTime = issueSignedServerTime(generatedAtMs);
    } catch {
      // Keyring unavailable — degrade the envelope, never the request.
      serverTimeError = "SERVER_TIME_UNAVAILABLE";
    }

    const privatePrefix = `${userId}:`;

    const [profile, watchlist, portfolio, notifications, platform, ledgerSequence] =
      await Promise.all([
        this.runSection("profile", `${privatePrefix}profile`, () =>
          getUserProfileSummary(this.prisma, userId),
        ),
        this.runSection("watchlist", `${privatePrefix}watchlist`, async () => ({
          watchedArenaIds: await this.watchlistService.list(userId),
        })),
        this.runSection("portfolio", `${privatePrefix}portfolio`, () =>
          this.portfolioService.getPortfolioExposure(userId),
        ),
        this.runSection("notifications", `${privatePrefix}notifications`, () =>
          this.notificationsService.getPreferences(userId),
        ),
        this.runSection("platform", `public:platform`, () => this.maintenanceService.getStatus()),
        this.resolveLedgerSequence(),
      ]);

    const sections = { profile, watchlist, portfolio, notifications, platform };
    const allOk = Object.values(sections).every((section) => section.state === "ok");
    const outcome = allOk ? "ok" : "partial";

    dashboardBootstrapTotal.inc({ outcome });

    return {
      version: 1,
      requestId,
      serverTime,
      ...(serverTimeError ? { serverTimeError } : {}),
      configRevision: computeConfigRevision(),
      ledgerSequence,
      generatedAtMs,
      outcome,
      sections,
    };
  }

  private async runSection<T>(
    section: SectionName,
    cacheKey: string,
    load: () => Promise<T>,
  ): Promise<BootstrapSection<T>> {
    const start = Date.now();
    // Promise.resolve().then(load) converts synchronous throws into
    // rejections so one broken section can never reject the composition.
    const [result] = await Promise.allSettled([
      withTimeout(Promise.resolve().then(load), SECTION_TIMEOUT_MS),
    ]);
    return toSection(section, cacheKey, start, result);
  }

  private async resolveLedgerSequence(): Promise<number | null> {
    try {
      return await getCurrentLedgerSequence();
    } catch {
      return null;
    }
  }
}
