import { Router, type RequestHandler } from "express";
import { asyncHandler } from "../middleware/validate";
import { publicCache } from "../middleware/cachePolicy";
import { getStellarConfig } from "../config/stellarConfig";
import { apiError } from "../utils/apiError";
import { z } from "zod";
import { buildCompatibilityManifest } from "../services/compatibilityManifest";
import type { Request, Response } from "express";

interface ProtocolConfig {
  sorobanRpcUrl: string;
  networkPassphrase: string;
  roundConfirmPollMs: number;
  roundConfirmMaxPolls: number;
  ledgerVersion: number;
  timestamp: string;
}

let cachedLedgerVersion: number | null = null;
let cachedTimestamp: string | null = null;
let lastFetchTime: number = 0;
const CACHE_DURATION_MS = 30000;

async function getLedgerVersion(): Promise<{ version: number; timestamp: string }> {
  const now = Date.now();

  if (cachedLedgerVersion !== null && now - lastFetchTime < CACHE_DURATION_MS) {
    return {
      version: cachedLedgerVersion,
      timestamp: cachedTimestamp!,
    };
  }

  try {
    const stellarConfig = getStellarConfig();
    const { Server } = await import("@stellar/stellar-sdk").then((m) => m.rpc);
    const server = new Server(stellarConfig.sorobanRpcUrl, { allowHttp: false });

    const ledger = await server.getLatestLedger();
    cachedLedgerVersion = ledger.sequence;
    cachedTimestamp = new Date(ledger.closedAt).toISOString();
    lastFetchTime = now;

    return {
      version: cachedLedgerVersion,
      timestamp: cachedTimestamp,
    };
  } catch (error) {
    if (cachedLedgerVersion !== null) {
      return {
        version: cachedLedgerVersion,
        timestamp: cachedTimestamp!,
      };
    }
    throw error;
  }
}

const CompatibilityQuerySchema = z.object({
  arenaId: z.string().regex(/^C[A-Z2-7]{55}$/).optional(),
});

/**
 * A manifest may be cached briefly, but a client can never act on an old one
 * unknowingly: every response carries `configRevision` (the ledger it was
 * derived at) and clients refuse to replace a manifest with a lower revision.
 *
 * #1626 — kept as the documented reference value; the route now emits the
 * equivalent through `publicCache` so the personalized-request guard applies
 * uniformly.
 */
export const COMPATIBILITY_CACHE_CONTROL = "public, max-age=15, must-revalidate";

/**
 * #1626 — the protocol config is identical for every anonymous caller and only
 * changes when the deployment's Soroban config does, so it is safe to serve
 * from a shared cache with background revalidation. `max-age` is short (the
 * endpoint already reports a fresh ledger each call) while the stale window
 * lets the edge absorb bursts without touching the origin.
 */
const PROTOCOL_CONFIG_CACHE = {
  maxAge: 15,
  staleWhileRevalidate: 120,
  staleIfError: 600,
} as const;

export function createConfigRouter(
  deps: { buildManifest?: typeof buildCompatibilityManifest } = {},
): Router {
  const router = Router();
  const buildManifest = deps.buildManifest ?? buildCompatibilityManifest;

  /**
   * GET /api/config/protocol
   * Returns the current protocol configuration with ledger-versioned responses.
   * Clients can use this to detect network/contract deployment changes.
   *
   * Response includes:
   * - Current Soroban RPC endpoint
   * - Network passphrase for transaction signing
   * - Confirmation polling parameters
   * - Current ledger version and timestamp for change detection
   */
  router.get(
    "/protocol",
    publicCache(PROTOCOL_CONFIG_CACHE),
    asyncHandler(async (req: Request, res: Response) => {
      try {
        const stellarConfig = getStellarConfig();
        const { version: ledgerVersion, timestamp } = await getLedgerVersion();

        const config: ProtocolConfig = {
          sorobanRpcUrl: stellarConfig.sorobanRpcUrl,
          networkPassphrase: stellarConfig.networkPassphrase,
          roundConfirmPollMs: stellarConfig.roundConfirmPollMs,
          roundConfirmMaxPolls: stellarConfig.roundConfirmMaxPolls,
          ledgerVersion,
          timestamp,
        };

        res.json({
          config,
          requestId: require("crypto").randomUUID(),
        });
      } catch (error) {
        if (error instanceof Error) {
          throw apiError(503, "CONFIG_FETCH_ERROR", `Failed to fetch protocol configuration: ${error.message}`);
        }
        throw error;
      }
    }),
  );

  /**
   * GET /api/config/compatibility[?arenaId=C...]
   * Returns the versioned client compatibility manifest (#1491): the network,
   * the ledger it was derived at, negotiated contract versions and the named
   * client capabilities this deployment supports. Pass `arenaId` to include
   * that arena's contract instance; without it, arena-scoped capabilities are
   * reported as `unknown`.
   */
  router.get(
    "/compatibility",
    publicCache(PROTOCOL_CONFIG_CACHE),
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = CompatibilityQuerySchema.safeParse({ arenaId: req.query.arenaId });
      if (!parsed.success) {
        throw apiError(400, "INVALID_ARENA_ID", "arenaId must be a Soroban contract id");
      }

      try {
        const manifest = await buildManifest(parsed.data);
        res.json(manifest);
      } catch {
        // The manifest carries no partial answer: without a ledger there is no revision to stamp.
        throw apiError(503, "CONFIG_FETCH_ERROR", "Failed to build compatibility manifest");
      }
    }),
  );

  return router;
}
