import { createHmac, randomUUID } from "crypto";
import { logger } from "../utils/logger";
import { cache, tags } from "../cache/cacheService";
import { invalidateContractCapability } from "./contractCapability";

/**
 * On-chain configuration change -> edge cache revalidation (#1626).
 *
 * When the protocol configuration changes on chain (a contract is upgraded, a
 * fee schedule revision ships, a new arena factory is deployed), two layers of
 * cache are now stale:
 *
 *   1. Backend Redis response caches (arena lists, compatibility manifest,
 *      landing stats) tagged so they can be invalidated by tag.
 *   2. The frontend's ISR-rendered landing page, which caches its server-side
 *      fetches for up to 60s and would otherwise show stale statistics until
 *      the window elapsed.
 *
 * This service is the single chokepoint for both. `revalidateConfig` purges
 * the backend tags and fires a signed POST to the frontend's
 * `/api/revalidate` route handler, which calls `revalidatePath`/`revalidateTag`
 * on the Next.js side. Failure to reach the frontend is logged and swallowed:
 * the ISR window is a bounded backstop, so a missed webhook degrades to "stale
 * for at most one revalidate window" rather than an error surfaced to the
 * on-chain event source.
 *
 * Authentication: the frontend route verifies an HMAC-SHA256 signature over the
 * raw request body using a shared secret. The `x-revalidate-signature` header
 * carries `sha256=<hex>`; the `x-revalidate-timestamp` header bounds replay.
 */

export const REVALIDATE_SIGNATURE_HEADER = "x-revalidate-signature";
export const REVALIDATE_TIMESTAMP_HEADER = "x-revalidate-timestamp";
export const REVALIDATE_EVENT_HEADER = "x-revalidate-event";

export interface RevalidationConfig {
  /** Frontend origin, e.g. https://app.inversearena.io. */
  frontendOrigin: string;
  /** Shared HMAC secret. When unset, frontend notification is skipped. */
  secret: string | undefined;
  /** Fetch implementation; injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface RevalidationResult {
  /** Cache tags successfully purged on the backend. */
  purgedTags: string[];
  /** Contract ids whose capability/metadata caches were invalidated. */
  invalidatedContracts: string[];
  /** Whether the frontend webhook returned a 2xx. */
  frontendNotified: boolean;
  /** Error message when the frontend webhook failed; never thrown. */
  frontendError?: string;
  /** Idempotency id for this revalidation, for log correlation. */
  requestId: string;
}

/** Signs a revalidation body exactly as the frontend verifier expects. */
export function signRevalidationBody(secret: string, timestamp: string, rawBody: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export class RevalidationService {
  constructor(private readonly config: RevalidationConfig) {}

  /**
   * Revalidate both cache layers after an on-chain configuration change.
   *
   * @param reason   Short human label for logs/metrics (e.g. "contract_upgrade").
   * @param contracts Contract ids whose derived caches must be dropped. Optional;
   *                  when omitted only the global config tags are purged.
   */
  async revalidateConfig(
    reason: string,
    contracts: string[] = [],
  ): Promise<RevalidationResult> {
    const requestId = randomUUID();

    const purgedTags = ["arenas:list", "leaderboard"];
    for (const tag of purgedTags) {
      try {
        await cache.invalidate(tag);
      } catch (error) {
        logger.warn({ err: error, tag, requestId }, "Failed to invalidate cache tag during revalidation");
      }
    }

    const invalidatedContracts: string[] = [];
    for (const contractId of contracts) {
      invalidateContractCapability(contractId, "upgrade_detected");
      invalidatedContracts.push(contractId);
    }

    const result: RevalidationResult = {
      purgedTags,
      invalidatedContracts,
      frontendNotified: false,
      requestId,
    };

    if (!this.config.secret) {
      logger.info(
        { event: "config_revalidation", reason, requestId, frontend: "skipped_unconfigured" },
        "Revalidated backend caches; frontend webhook not configured",
      );
      return result;
    }

    try {
      await this.notifyFrontend(reason, requestId);
      result.frontendNotified = true;
    } catch (error) {
      result.frontendError = error instanceof Error ? error.message : String(error);
      logger.warn(
        { err: error, reason, requestId },
        "Frontend revalidation webhook failed; ISR window is the backstop",
      );
    }

    logger.info(
      {
        event: "config_revalidation",
        reason,
        requestId,
        purgedTags,
        invalidatedContracts,
        frontendNotified: result.frontendNotified,
      },
      "On-chain configuration change revalidated caches",
    );

    return result;
  }

  private async notifyFrontend(reason: string, requestId: string): Promise<void> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({ reason, requestId });
    const signature = signRevalidationBody(this.config.secret!, timestamp, rawBody);
    const url = new URL("/api/revalidate", this.config.frontendOrigin).toString();
    const fetchImpl = this.config.fetchImpl ?? fetch;

    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [REVALIDATE_SIGNATURE_HEADER]: signature,
        [REVALIDATE_TIMESTAMP_HEADER]: timestamp,
        [REVALIDATE_EVENT_HEADER]: reason,
      },
      body: rawBody,
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Frontend revalidation returned ${response.status}`);
    }
  }
}

/** Tags referenced by revalidation. Exported for the caller/tests. */
export const REVALIDATION_TAGS = [tags.arenas(), tags.leaderboard()] as const;
