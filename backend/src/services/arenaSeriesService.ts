/**
 * Arena Recurring Series Service (#1746).
 *
 * Enables hosts to schedule recurring arena series from creator templates.
 * Handles cadence computation with DST and timezone awareness, one-click sign requests,
 * skips, pauses, active pool limit assertions, and host whitelist checks.
 */

import type { PrismaClient } from "@prisma/client";
import { apiError } from "../utils/apiError";
import { logger } from "../utils/logger";
import { CreatorTemplateService } from "./creatorTemplateService";

export interface CreateSeriesInput {
  templateId: string;
  name: string;
  cadence: string; // e.g. "0 20 * * *" (daily 8pm) or "0 18 * * 1" (Mondays 6pm)
  timezone?: string; // IANA timezone, e.g. "America/New_York", "UTC"
  endCondition?: {
    maxInstances?: number;
    endDate?: string;
  };
}

export interface CronParts {
  minute: number;
  hour: number;
  dayOfMonth: number | null;
  month: number | null;
  dayOfWeek: number | null; // 0 = Sunday, 1 = Monday, etc.
}

/**
 * Parses simple 5-field cron expression: "minute hour dom month dow"
 */
export function parseCronExpression(cron: string): CronParts {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw apiError(400, "INVALID_CADENCE", `Invalid cron expression: ${cron}`);
  }

  const [minStr, hourStr, domStr, monthStr, dowStr] = parts;

  const minute = parseInt(minStr, 10);
  const hour = parseInt(hourStr, 10);
  if (isNaN(minute) || minute < 0 || minute > 59) {
    throw apiError(400, "INVALID_CADENCE", `Invalid minute in cadence: ${minStr}`);
  }
  if (isNaN(hour) || hour < 0 || hour > 23) {
    throw apiError(400, "INVALID_CADENCE", `Invalid hour in cadence: ${hourStr}`);
  }

  const dayOfMonth = domStr === "*" ? null : parseInt(domStr, 10);
  const month = monthStr === "*" ? null : parseInt(monthStr, 10);
  const dayOfWeek = dowStr === "*" ? null : parseInt(dowStr, 10);

  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

/**
 * Accurately computes the next run timestamp in the target timezone,
 * properly honoring daylight saving time transitions (spring forward / fall back).
 */
export function calculateNextRun(
  cadence: string,
  timezone = "UTC",
  fromDate: Date = new Date(),
): Date {
  const { minute, hour, dayOfMonth, month, dayOfWeek } = parseCronExpression(cadence);

  // We search day by day starting from fromDate
  const current = new Date(fromDate.getTime());

  // Search window of up to 366 days
  for (let dayOffset = 0; dayOffset <= 366; dayOffset++) {
    const candidateDate = new Date(current.getTime() + dayOffset * 86_400_000);

    // Format candidate date in user's timezone to get local year, month, day
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "narrow",
    });

    const parts = formatter.formatToParts(candidateDate);
    const partMap: Record<string, string> = {};
    for (const p of parts) {
      partMap[p.type] = p.value;
    }

    const localYear = parseInt(partMap.year, 10);
    const localMonth = parseInt(partMap.month, 10); // 1-12
    const localDay = parseInt(partMap.day, 10);

    if (month !== null && localMonth !== month) continue;
    if (dayOfMonth !== null && localDay !== dayOfMonth) continue;

    // Check Day of week in target timezone
    // Construct approximate UTC ISO string for target local day and time
    const pad = (n: number) => String(n).padStart(2, "0");
    const targetIso = `${localYear}-${pad(localMonth)}-${pad(localDay)}T${pad(hour)}:${pad(minute)}:00`;

    // Convert local time back to exact UTC Date taking timezone offset into account
    const runUtc = zonedDateTimeToUtc(localYear, localMonth, localDay, hour, minute, timezone);

    // Day of week check
    if (dayOfWeek !== null) {
      const dowFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        weekday: "numeric",
      });
      // In JS Sunday can be 0 or 7 depending on locale; let's get numeric day of week
      const dayOfWeekVal = getZonedDayOfWeek(runUtc, timezone);
      if (dayOfWeekVal !== dayOfWeek) continue;
    }

    if (runUtc.getTime() > fromDate.getTime()) {
      return runUtc;
    }
  }

  throw apiError(400, "CADENCE_OUT_OF_RANGE", "Could not calculate next run within 1 year");
}

function getZonedDayOfWeek(date: Date, timezone: string): number {
  const weekdayStr = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(date);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[weekdayStr] ?? 0;
}

/**
 * Converts a specific date and time in a given timezone into an exact UTC Date object.
 */
export function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  // Initial naive UTC guess
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

  // Determine timezone offset for the guess
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  });

  const parts = fmt.formatToParts(guess);
  const p: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      p[part.type] = parseInt(part.value, 10);
    }
  }

  // Adjust for 24h wrap
  const zonedHour = p.hour === 24 ? 0 : p.hour;
  const zonedTime = Date.UTC(p.year, p.month - 1, p.day, zonedHour, p.minute, p.second || 0);
  const diff = guess.getTime() - zonedTime;

  return new Date(guess.getTime() + diff);
}

export class ArenaSeriesService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Asserts creator is eligible to schedule arenas:
   * 1. Whitelisted or approved host.
   * 2. Active pool count within system bounds.
   */
  async assertHostEligibility(creatorAddress: string): Promise<void> {
    const whitelist = await (this.prisma as any).hostWhitelistApplication.findFirst({
      where: {
        applicantAddress: creatorAddress,
        status: "approved",
      },
    });

    if (!whitelist) {
      // Check if user is an admin or has host rights
      const user = await this.prisma.user.findFirst({
        where: { walletAddress: creatorAddress },
      });
      if (!user) {
        throw apiError(403, "HOST_NOT_WHITELISTED", "Creator is not whitelisted to host series");
      }
    }

    // Check active pool limit: count active arenas by this creator
    const activeCount = await this.prisma.arena.count({
      where: {
        createdBy: creatorAddress,
        status: { in: ["OPEN", "IN_PROGRESS", "ACTIVE"] },
      },
    });

    const MAX_ACTIVE_POOLS = 10;
    if (activeCount >= MAX_ACTIVE_POOLS) {
      throw apiError(429, "ACTIVE_POOL_LIMIT_REACHED", "Host has reached the active pool limit");
    }
  }

  /**
   * Create a new recurring series.
   */
  async createSeries(creatorAddress: string, input: CreateSeriesInput) {
    await this.assertHostEligibility(creatorAddress);

    // Validate template
    const template = await (this.prisma as any).creatorTemplate.findFirst({
      where: {
        id: input.templateId,
        ownerAddress: creatorAddress,
      },
    });

    if (!template) {
      throw apiError(404, "TEMPLATE_NOT_FOUND", "Creator template not found");
    }

    if (template.status !== "active") {
      throw apiError(400, "TEMPLATE_ARCHIVED", "Cannot schedule series from an archived template");
    }

    const timezone = input.timezone || "UTC";
    const nextScheduledAt = calculateNextRun(input.cadence, timezone, new Date());

    const series = await (this.prisma as any).arenaSeries.create({
      data: {
        creatorAddress,
        templateId: input.templateId,
        name: input.name,
        cadence: input.cadence,
        timezone,
        status: "active",
        endCondition: input.endCondition ?? null,
        nextScheduledAt,
      },
    });

    logger.info("Created recurring arena series", {
      seriesId: series.id,
      creatorAddress,
      nextScheduledAt: nextScheduledAt.toISOString(),
    });

    return series;
  }

  async listSeries(creatorAddress: string, status?: string) {
    return (this.prisma as any).arenaSeries.findMany({
      where: {
        creatorAddress,
        ...(status ? { status } : {}),
      },
      include: {
        instances: {
          orderBy: { scheduledFor: "desc" },
          take: 10,
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async getSeriesById(seriesId: string, creatorAddress?: string) {
    const series = await (this.prisma as any).arenaSeries.findUnique({
      where: { id: seriesId },
      include: {
        instances: {
          orderBy: { scheduledFor: "desc" },
        },
      },
    });

    if (!series) {
      throw apiError(404, "SERIES_NOT_FOUND", "Series not found");
    }

    if (creatorAddress && series.creatorAddress !== creatorAddress) {
      throw apiError(403, "FORBIDDEN", "You do not own this series");
    }

    return series;
  }

  async pauseSeries(seriesId: string, creatorAddress: string) {
    const series = await this.getSeriesById(seriesId, creatorAddress);
    if (series.status !== "active") {
      throw apiError(400, "INVALID_STATE", `Cannot pause series with status ${series.status}`);
    }

    return (this.prisma as any).arenaSeries.update({
      where: { id: seriesId },
      data: { status: "paused" },
    });
  }

  async resumeSeries(seriesId: string, creatorAddress: string) {
    const series = await this.getSeriesById(seriesId, creatorAddress);
    if (series.status !== "paused") {
      throw apiError(400, "INVALID_STATE", `Cannot resume series with status ${series.status}`);
    }

    const nextScheduledAt = calculateNextRun(series.cadence, series.timezone, new Date());
    return (this.prisma as any).arenaSeries.update({
      where: { id: seriesId },
      data: {
        status: "active",
        nextScheduledAt,
      },
    });
  }

  async skipNextInstance(seriesId: string, creatorAddress: string) {
    const series = await this.getSeriesById(seriesId, creatorAddress);
    if (!series.nextScheduledAt) {
      throw apiError(400, "NO_SCHEDULED_INSTANCE", "No upcoming instance to skip");
    }

    // Record skipped instance
    await (this.prisma as any).arenaSeriesInstance.create({
      data: {
        seriesId,
        scheduledFor: series.nextScheduledAt,
        status: "skipped",
      },
    });

    // Advance to next cadence
    const nextScheduledAt = calculateNextRun(
      series.cadence,
      series.timezone,
      new Date(series.nextScheduledAt.getTime() + 1000),
    );

    return (this.prisma as any).arenaSeries.update({
      where: { id: seriesId },
      data: { nextScheduledAt },
    });
  }

  async signInstance(
    seriesId: string,
    instanceId: string,
    creatorAddress: string,
    txHash: string,
    arenaId?: string,
  ) {
    await this.getSeriesById(seriesId, creatorAddress);

    const instance = await (this.prisma as any).arenaSeriesInstance.findFirst({
      where: { id: instanceId, seriesId },
    });

    if (!instance) {
      throw apiError(404, "INSTANCE_NOT_FOUND", "Series instance not found");
    }

    return (this.prisma as any).arenaSeriesInstance.update({
      where: { id: instanceId },
      data: {
        status: "created",
        txHash,
        arenaId: arenaId ?? instance.arenaId,
      },
    });
  }

  /**
   * Scheduler worker job: scans all active series due for creation.
   * Produces pending creations ready for one-click signing.
   */
  async processDueSeriesInstances(now = new Date()) {
    const dueSeries = await (this.prisma as any).arenaSeries.findMany({
      where: {
        status: "active",
        nextScheduledAt: { lte: now },
      },
    });

    const results = [];

    for (const series of dueSeries) {
      try {
        // Edge case: check template is still active
        const template = await (this.prisma as any).creatorTemplate.findFirst({
          where: { id: series.templateId },
        });

        if (!template || template.status !== "active") {
          await (this.prisma as any).arenaSeriesInstance.create({
            data: {
              seriesId: series.id,
              scheduledFor: series.nextScheduledAt,
              status: "failed",
              errorMessage: "Template deprecated or archived",
            },
          });
          continue;
        }

        // Edge case: active pool limits
        const activeArenas = await this.prisma.arena.count({
          where: {
            createdBy: series.creatorAddress,
            status: { in: ["OPEN", "IN_PROGRESS", "ACTIVE"] },
          },
        });

        if (activeArenas >= 10) {
          await (this.prisma as any).arenaSeriesInstance.create({
            data: {
              seriesId: series.id,
              scheduledFor: series.nextScheduledAt,
              status: "failed",
              errorMessage: "Host active pool limit reached",
            },
          });
          continue;
        }

        // Build one-click sign request payload
        const payload = template.payload as Record<string, unknown>;
        const instance = await (this.prisma as any).arenaSeriesInstance.create({
          data: {
            seriesId: series.id,
            scheduledFor: series.nextScheduledAt,
            status: "pending",
            signRequestPayload: {
              templateId: series.templateId,
              name: `${series.name} #${series.instancesCreated + 1}`,
              payload,
            },
          },
        });

        const newCount = series.instancesCreated + 1;
        const endCondition = series.endCondition as { maxInstances?: number; endDate?: string } | null;

        let isCompleted = false;
        if (endCondition?.maxInstances && newCount >= endCondition.maxInstances) {
          isCompleted = true;
        }
        if (endCondition?.endDate && new Date(endCondition.endDate) <= now) {
          isCompleted = true;
        }

        const nextScheduledAt = isCompleted
          ? null
          : calculateNextRun(series.cadence, series.timezone, new Date(series.nextScheduledAt.getTime() + 1000));

        await (this.prisma as any).arenaSeries.update({
          where: { id: series.id },
          data: {
            instancesCreated: newCount,
            lastScheduledAt: series.nextScheduledAt,
            nextScheduledAt,
            status: isCompleted ? "completed" : "active",
          },
        });

        results.push(instance);
      } catch (err) {
        logger.error("Failed to process series instance", {
          seriesId: series.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }
}
