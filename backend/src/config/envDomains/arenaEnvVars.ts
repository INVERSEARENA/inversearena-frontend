import { z } from "zod";
import type { EnvVarSpec } from "../envSpec";
import { accountId, contractId, csv, decimal, flag, int, isoTimestamp, kid, rateLimit, rotation, secretSeed, text, url } from "../envSpec";

export const arenaEnvVars = {
  MAX_ACTIVE_STAKE_USDC: {
    section: "Arenas",
    description: "Cap on a wallet's total active stake, in USDC.",
    default: "10000",
    schema: z.string().regex(/^\d+(\.\d+)?$/, "must be a non-negative number"),
  },
  LOBBY_RESERVATION_TTL_SECONDS: {
    section: "Arenas",
    description: "How long a lobby seat reservation is held.",
    default: "120",
    schema: int(1),
  },
  ALIAS_BLOCK_LIST: {
    section: "Arenas",
    description: "Extra comma-separated words rejected in player aliases.",
    schema: z.string(),
  },
  PLATFORM_FEE_BPS: {
    section: "Arenas",
    description: "Basis points of a round's yield withheld as platform fee in settlement receipts (#1407).",
    example: "0",
    default: "0",
    schema: int(0, 10_000),
  }
} satisfies Record<string, EnvVarSpec>;
