import { Router, type RequestHandler } from "express";
import { asyncHandler } from "../middleware/validate";
import { getStellarConfig } from "../config/stellarConfig";
import { apiError } from "../utils/apiError";
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

export function createConfigRouter(): Router {
  const router = Router();

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

  return router;
}
