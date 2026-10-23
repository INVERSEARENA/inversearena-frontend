/**
 * Rematch pools (#1572).
 *
 * A rematch is a new arena created by the same host from a finished arena's
 * canonical on-chain pool configuration — never from cached UI state. This
 * module:
 *
 *  - derives and prefills the source arena's config from chain reads
 *    (`getRematchConfig`),
 *  - decides whether a rematch is currently possible and, if not, why
 *    (`evaluateRematchEligibility`, pure),
 *  - notifies the source arena's prior participants once the rematch pool is
 *    linked (`notifyPriorParticipants`).
 *
 * The linkage itself (`Arena.rematchOf`) is written by
 * `ArenaService.confirmArenaDeployment`, which also enforces idempotency.
 */

import type { PrismaClient } from "@prisma/client";
import { env } from "../config/env";
import type { OnChainReadResult } from "../types/onChainRead";
import { hasReadValue } from "../types/onChainRead";
import {
  getArenaPoolConfig,
  getFactoryActivePoolCount,
  getFactoryMaxActivePools,
  isFactoryOracleApproved,
  isFactoryTokenSupported,
  isFactoryVaultApproved,
  readOnChainGameState,
  type OnChainArenaPoolConfig,
  type OnChainGameState,
} from "./onChainReader";
import { NotificationPreferencesService } from "./notificationPreferencesService";
import { PushService } from "./pushService";

/** Why a rematch cannot be created right now. */
export type RematchBlockedReason =
  | "SOURCE_CONFIG_UNAVAILABLE"
  | "SOURCE_ARENA_NOT_FINISHED"
  | "STAKE_TOKEN_NOT_SUPPORTED"
  | "YIELD_VAULT_NOT_APPROVED"
  | "ORACLE_NOT_APPROVED"
  | "HOST_ACTIVE_POOL_LIMIT";

/** Human-readable explanation for each blocked reason, safe to surface. */
export const REMATCH_BLOCKED_MESSAGES: Record<RematchBlockedReason, string> = {
  SOURCE_CONFIG_UNAVAILABLE:
    "The arena's on-chain configuration could not be read, so a rematch cannot be prefilled safely.",
  SOURCE_ARENA_NOT_FINISHED: "The arena has not finished yet.",
  STAKE_TOKEN_NOT_SUPPORTED: "The arena's stake token is no longer supported by the factory.",
  YIELD_VAULT_NOT_APPROVED: "The arena's yield vault is no longer approved by the factory.",
  ORACLE_NOT_APPROVED: "The arena's oracle is no longer approved by the factory.",
  HOST_ACTIVE_POOL_LIMIT: "The host already has the maximum number of active pools.",
};

export interface RematchEligibilityChecks {
  /** The source arena reached `Finished` on-chain. */
  sourceFinished: boolean;
  /** The source stake token is still on the factory's supported list. */
  tokenSupported: boolean;
  /** The source yield vault is still approved. */
  vaultApproved: boolean;
  /** The source oracle is still approved. */
  oracleApproved: boolean;
  /** Pools the host currently has in `Active` status. */
  hostActivePoolCount: number;
  /** The factory's global `max_active_pools` cap. */
  hostMaxActivePools: number;
}

export interface RematchEligibility {
  available: boolean;
  blockedReason: RematchBlockedReason | null;
  blockedMessage: string | null;
}

/**
 * Pure decision function for rematch availability (#1572).
 *
 * Order matters for the returned reason: a source arena that is still running
 * is reported as such even if a token was also delisted, because finishing is
 * the prerequisite the host will hit first. Delisted-token/vault/oracle checks
 * come next (their prefills would be rejected by `create_pool`), and the host's
 * active-pool headroom last.
 */
export function evaluateRematchEligibility(
  checks: RematchEligibilityChecks,
): RematchEligibility {
  const blocked = (reason: RematchBlockedReason): RematchEligibility => ({
    available: false,
    blockedReason: reason,
    blockedMessage: REMATCH_BLOCKED_MESSAGES[reason],
  });

  if (!checks.sourceFinished) return blocked("SOURCE_ARENA_NOT_FINISHED");
  if (!checks.tokenSupported) return blocked("STAKE_TOKEN_NOT_SUPPORTED");
  if (!checks.vaultApproved) return blocked("YIELD_VAULT_NOT_APPROVED");
  if (!checks.oracleApproved) return blocked("ORACLE_NOT_APPROVED");
  if (checks.hostActivePoolCount >= checks.hostMaxActivePools) {
    return blocked("HOST_ACTIVE_POOL_LIMIT");
  }

  return { available: true, blockedReason: null, blockedMessage: null };
}

/** Canonical config a rematch prefill is built from. */
export interface RematchPrefillConfig {
  stakeToken: string;
  yieldVault: string;
  entryFee: string;
  oracleContract: string;
  minPlayers: number;
  maxPlayers: number;
  /** Recorded at the first `start_round`; always set for a finished arena. */
  roundDuration: number;
}

export interface RematchConfigResponse {
  arenaId: string;
  available: boolean;
  blockedReason: RematchBlockedReason | null;
  blockedMessage: string | null;
  /** Wallet address of the source arena's host. */
  host: string;
  /** Factory pool id the source arena was created under. */
  poolId: number;
  /** Factory contract that owns the pool (from the arena's own config). */
  factoryContractId: string;
  /** Whether the requesting wallet took part in the source arena. */
  isPriorParticipant: boolean;
  config: RematchPrefillConfig | null;
}

export class RematchArenaNotFoundError extends Error {
  constructor(readonly arenaId: string) {
    super(`Arena ${arenaId} not found`);
    this.name = "RematchArenaNotFoundError";
  }
}

export class RematchConfigUnavailableError extends Error {
  constructor(
    readonly arenaId: string,
    message: string,
  ) {
    super(message);
    this.name = "RematchConfigUnavailableError";
  }
}

/**
 * The chain reads `RematchService` needs, injectable so unit tests can
 * exercise the derivation/decision logic without an RPC server.
 */
export interface RematchReaders {
  getArenaPoolConfig: (arenaContractId: string) => Promise<OnChainArenaPoolConfig>;
  readOnChainGameState: (arenaContractId: string) => Promise<OnChainReadResult<OnChainGameState>>;
  isFactoryTokenSupported: (factoryContractId: string, token: string) => Promise<boolean>;
  isFactoryVaultApproved: (factoryContractId: string, vault: string) => Promise<boolean>;
  isFactoryOracleApproved: (factoryContractId: string, oracle: string) => Promise<boolean>;
  getFactoryActivePoolCount: (factoryContractId: string, host: string) => Promise<number>;
  getFactoryMaxActivePools: (factoryContractId: string) => Promise<number>;
}

const defaultReaders: RematchReaders = {
  getArenaPoolConfig,
  readOnChainGameState,
  isFactoryTokenSupported,
  isFactoryVaultApproved,
  isFactoryOracleApproved,
  getFactoryActivePoolCount,
  getFactoryMaxActivePools,
};

interface ArenaMetadataJson {
  createdBy?: unknown;
}

/**
 * Derive a finished arena's canonical rematch config from chain reads.
 *
 * Throws `RematchArenaNotFoundError` when the arena row does not exist and
 * `RematchConfigUnavailableError` when the source config cannot be read or the
 * arena has no recorded host. A blocked (but readable) rematch is returned as
 * `available: false` with a reason — that is a normal answer, not an error.
 */
export class RematchService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly readers: RematchReaders = defaultReaders,
  ) {}

  async getRematchConfig(
    arenaId: string,
    userWallet?: string | null,
  ): Promise<RematchConfigResponse> {
    const arena = await this.prisma.arena.findUnique({
      where: { id: arenaId },
      select: { id: true, metadata: true },
    });
    if (!arena) throw new RematchArenaNotFoundError(arenaId);

    const metadata = (arena.metadata ?? {}) as ArenaMetadataJson;
    const host = typeof metadata.createdBy === "string" ? metadata.createdBy : null;
    if (!host) {
      throw new RematchConfigUnavailableError(
        arenaId,
        "Arena has no recorded host; cannot attribute a rematch.",
      );
    }

    let config: OnChainArenaPoolConfig;
    try {
      config = await this.readers.getArenaPoolConfig(arenaId);
    } catch (error) {
      throw new RematchConfigUnavailableError(
        arenaId,
        `Could not read the arena's on-chain pool config: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // The contract names its own factory; fall back to the configured one for
    // arenas deployed before the view exposed it.
    const factoryContractId =
      config.factory || env.ARENA_FACTORY_CONTRACT_ID || "";
    if (!factoryContractId) {
      throw new RematchConfigUnavailableError(
        arenaId,
        "No factory contract is configured, so rematch policy cannot be checked.",
      );
    }

    const [gameState, tokenSupported, vaultApproved, oracleApproved, activeCount, maxPools] =
      await Promise.all([
        this.readers.readOnChainGameState(arenaId),
        this.readers.isFactoryTokenSupported(factoryContractId, config.stakeToken),
        this.readers.isFactoryVaultApproved(factoryContractId, config.yieldVault),
        this.readers.isFactoryOracleApproved(factoryContractId, config.oracleContract),
        this.readers.getFactoryActivePoolCount(factoryContractId, host),
        this.readers.getFactoryMaxActivePools(factoryContractId),
      ]);

    const eligibility = evaluateRematchEligibility({
      sourceFinished: hasReadValue(gameState) && gameState.value === "Finished",
      tokenSupported,
      vaultApproved,
      oracleApproved,
      hostActivePoolCount: activeCount,
      hostMaxActivePools: maxPools,
    });

    return {
      arenaId,
      available: eligibility.available,
      blockedReason: eligibility.blockedReason,
      blockedMessage: eligibility.blockedMessage,
      host,
      poolId: config.poolId,
      factoryContractId,
      isPriorParticipant: await this.isPriorParticipant(arenaId, userWallet ?? null),
      config: {
        stakeToken: config.stakeToken,
        yieldVault: config.yieldVault,
        entryFee: config.entryFee.toString(),
        oracleContract: config.oracleContract,
        minPlayers: config.minPlayers,
        maxPlayers: config.maxPlayers,
        roundDuration: config.roundDuration,
      },
    };
  }

  /**
   * Whether a wallet took part in the source arena, as an elimination-log
   * participant or an active player recorded on any round (#1572 — this is
   * also the recipient set for rematch notifications).
   */
  async isPriorParticipant(arenaId: string, wallet: string | null): Promise<boolean> {
    if (!wallet) return false;
    const user = await this.prisma.user.findUnique({
      where: { walletAddress: wallet },
      select: { id: true },
    });
    if (!user) return false;

    const elimination = await this.prisma.eliminationLog.findFirst({
      where: { userId: user.id, round: { arenaId } },
      select: { id: true },
    });
    if (elimination) return true;

    const round = await this.prisma.round.findFirst({
      where: { arenaId, allActivePlayerIds: { has: wallet } },
      select: { id: true },
    });
    return round !== null;
  }

  /**
   * Notify the source arena's prior participants that a rematch pool is live
   * (#1572): one in-app inbox entry plus a best-effort push, each deduped per
   * (source arena, rematch arena).
   *
   * Never throws: notification failure must not undo a persisted rematch
   * linkage. Returns the number of participants notified in-app.
   */
  async notifyPriorParticipants(
    sourceArenaId: string,
    rematchArenaId: string,
    prefs: NotificationPreferencesService = new NotificationPreferencesService(this.prisma),
    push: PushService = new PushService(this.prisma, prefs),
  ): Promise<number> {
    const recipients = await this.findPriorParticipantUserIds(sourceArenaId);
    const dedupeKey = `rematch:${sourceArenaId}:${rematchArenaId}`;
    let notified = 0;

    for (const userId of recipients) {
      try {
        if (await prefs.shouldNotify(userId, "rematch", "in_app")) {
          const deliveryId = await prefs.recordDelivery(userId, "rematch", "in_app", dedupeKey);
          await prefs.markSent(deliveryId).catch(() => {});
          notified += 1;
        }
      } catch {
        // Per-user failure must not stop the fan-out.
      }
    }

    try {
      await push.scheduleRoundPhasePushes({
        arenaId: rematchArenaId,
        roundNumber: 0,
        type: "rematch",
        userIds: recipients,
        message: {
          title: "Rematch available",
          body: "The host has started a rematch. Join before the deadline.",
          url: `/arena/${rematchArenaId}`,
          tag: `rematch-${rematchArenaId}`,
        },
      });
    } catch {
      // Push is best-effort; the in-app inbox is the durable channel.
    }

    return notified;
  }

  /**
   * User ids of everyone who played the source arena: elimination-log
   * participants plus wallets recorded in any round's active-player list
   * (which also covers a winner who was never eliminated).
   */
  private async findPriorParticipantUserIds(arenaId: string): Promise<string[]> {
    const userIds = new Set<string>();

    const eliminations = await this.prisma.eliminationLog.findMany({
      where: { round: { arenaId } },
      select: { userId: true },
    });
    for (const row of eliminations) userIds.add(row.userId);

    const rounds = await this.prisma.round.findMany({
      where: { arenaId },
      select: { allActivePlayerIds: true },
    });
    const wallets = new Set<string>();
    for (const round of rounds) {
      for (const wallet of round.allActivePlayerIds) wallets.add(wallet);
    }
    if (wallets.size > 0) {
      const users = await this.prisma.user.findMany({
        where: { walletAddress: { in: [...wallets] } },
        select: { id: true },
      });
      for (const user of users) userIds.add(user.id);
    }

    return [...userIds];
  }
}
