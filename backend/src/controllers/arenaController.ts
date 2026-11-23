/**
 * Arena Controller (#1749).
 *
 * Coordinates HTTP requests with domain services, keeping routes thin and testable.
 */

import { randomUUID } from "crypto";
import type { Request, Response } from "express";
import { apiError } from "../utils/apiError";
import type { CreateArenaInput } from "../types/arena";
import type { ArenaService } from "../services/arenaService";
import type { ArenaQueryService } from "../services/arenaQueryService";
import type { ArenaParticipantsService } from "../services/arenaParticipantsService";
import type { ArenaStatsService } from "../services/arenaStatsService";
import type { ArenaYieldService } from "../services/arenaYieldService";
import type { RoundService } from "../services/roundService";
import type { ParticipantEligibilityService } from "../services/participantEligibilityService";
import type { ActiveStakeLimitsService } from "../services/activeStakeLimitsService";
import { ActiveStakeLimitError } from "../services/activeStakeLimitsService";
import type { ArenaHealthService } from "../services/arenaHealthService";
import type { DisputeEvidenceService } from "../services/disputeEvidenceService";
import {
  EvidenceArenaNotFoundError,
  EvidenceRoundNotFoundError,
  EvidenceNotParticipantError,
} from "../services/disputeEvidenceService";
import type { RematchService } from "../services/rematchService";
import {
  RematchArenaNotFoundError,
  RematchConfigUnavailableError,
} from "../services/rematchService";

function formatRound(round: {
  id: string;
  roundNumber: number;
  state: string;
  createdAt: Date;
  updatedAt: Date;
  eliminationCount: number;
  metadata: unknown;
}) {
  return {
    id: round.id,
    roundNumber: round.roundNumber,
    state: round.state,
    eliminationCount: round.eliminationCount,
    metadata: round.metadata,
    createdAt: round.createdAt.toISOString(),
    updatedAt: round.updatedAt.toISOString(),
  };
}

export class ArenaController {
  constructor(
    private readonly arenaService: ArenaService,
    private readonly arenaQueryService: ArenaQueryService,
    private readonly arenaParticipantsService: ArenaParticipantsService,
    private readonly arenaStatsService: ArenaStatsService,
    private readonly arenaYieldService: ArenaYieldService,
    private readonly getRoundService: () => RoundService,
    private readonly eligibilityService: ParticipantEligibilityService,
    private readonly stakeService: ActiveStakeLimitsService,
    private readonly arenaHealthService: ArenaHealthService,
    private readonly getDisputeEvidenceService: () => DisputeEvidenceService,
    private readonly rematchService: RematchService,
  ) {}

  async createArena(req: Request, res: Response) {
    const { txHash, ...rest } = req.body;
    const input = rest as unknown as CreateArenaInput;
    const createdBy = req.user?.walletAddress;
    const userId = req.user?.id;

    if (!createdBy || !userId) {
      throw apiError(401, "UNAUTHORIZED", "Unauthorized");
    }

    try {
      await this.stakeService.assertBelowActiveStakeLimit(userId, input.entryFee ?? 0);
    } catch (err) {
      if (err instanceof ActiveStakeLimitError) {
        throw apiError(409, err.code, err.message);
      }
      throw err;
    }

    const arena = await this.arenaService.confirmArenaDeployment(input, createdBy, txHash);
    res.status(201).json({
      arena,
      requestId: randomUUID(),
    });
  }

  async listArenas(req: Request, res: Response) {
    const { limit, cursor, filter, q } = req.query as any;
    const result = await this.arenaQueryService.listArenas({
      limit: limit ? Number(limit) : undefined,
      cursor: cursor as string | undefined,
      filter: filter as any,
      search: q as string | undefined,
    });
    res.json(result);
  }

  async getArenaStats(req: Request, res: Response) {
    const id = req.params.id!;
    const stats = await this.arenaStatsService.getStats(id);
    res.json(stats);
  }

  async getRematchConfig(req: Request, res: Response) {
    const id = req.params.id!;
    const callerWallet = req.user?.walletAddress;
    if (!callerWallet) {
      throw apiError(401, "UNAUTHORIZED", "Unauthorized");
    }

    try {
      const config = await this.rematchService.buildRematchPrefill(id, callerWallet);
      res.json(config);
    } catch (error) {
      if (error instanceof RematchArenaNotFoundError) {
        throw apiError(404, "ARENA_NOT_FOUND", error.message);
      }
      if (error instanceof RematchConfigUnavailableError) {
        throw apiError(503, "CONFIG_UNAVAILABLE", error.message);
      }
      throw error;
    }
  }

  async getArenaYield(req: Request, res: Response) {
    const id = req.params.id!;
    const limit = req.query.limit ? Number(req.query.limit) : 500;
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const result = await this.arenaYieldService.getYieldHistory(id, limit, cursor);
    res.json(result);
  }

  async getRounds(req: Request, res: Response) {
    const id = req.params.id!;
    const limit = req.query.limit ? Number(req.query.limit) : 25;
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const rounds = await this.getRoundService().listRounds(id, limit, cursor);
    res.json(rounds);
  }

  async getParticipants(req: Request, res: Response) {
    const id = req.params.id!;
    const limit = req.query.limit ? Number(req.query.limit) : 25;
    const cursor = req.query.cursor ? Number(req.query.cursor) : 0;
    const result = await this.arenaParticipantsService.getParticipants(id, limit, cursor);
    res.json(result);
  }

  async eligibilityPreflight(req: Request, res: Response) {
    const id = req.params.id!;
    const { balance, balanceAsset } = req.body;
    const playerWallet = req.user?.walletAddress;

    if (!id) throw apiError(400, "INVALID_ARENA_ID", "Arena ID is required");
    if (!playerWallet) throw apiError(401, "UNAUTHORIZED", "Wallet address required");

    const eligibility = await this.eligibilityService.checkFreshEligibility(
      id,
      playerWallet,
      balance,
      balanceAsset,
    );

    res.status(eligibility.isEligible ? 200 : 403).json({
      isEligible: eligibility.isEligible,
      errors: eligibility.errors,
      warnings: eligibility.warnings,
      snapshot: eligibility.snapshot,
      metadata: eligibility.metadata,
      requestId: randomUUID(),
    });
  }

  async getEligibilitySnapshot(req: Request, res: Response) {
    const arenaId = req.params.id!;
    const snapshotId = req.params.snapshotId!;
    const playerWallet = req.user?.walletAddress;

    if (!arenaId || !snapshotId) {
      throw apiError(400, "INVALID_ELIGIBILITY_SNAPSHOT", "Arena and snapshot IDs are required");
    }
    if (!playerWallet) {
      throw apiError(401, "UNAUTHORIZED", "Wallet address required");
    }

    const snapshot = this.eligibilityService.getSnapshot(snapshotId, arenaId, playerWallet);
    if (!snapshot) {
      throw apiError(404, "ELIGIBILITY_SNAPSHOT_EXPIRED", "Eligibility snapshot is missing or expired");
    }
    res.json(snapshot);
  }

  async getCommitStatus(req: Request, res: Response) {
    const { id: arenaId, roundNumber } = req.params as any;
    const callerWallet = req.user?.walletAddress;
    if (!callerWallet) throw apiError(401, "UNAUTHORIZED", "Unauthorized");

    await this.arenaQueryService.getArenaById(arenaId);
    const receipt = await this.getRoundService().getCommitStatus(
      arenaId,
      Number(roundNumber),
      callerWallet,
    );
    res.json(receipt);
  }

  async getEvidence(req: Request, res: Response) {
    if (req.query.walletAddress !== undefined || req.query.userId !== undefined) {
      throw apiError(
        400,
        "EVIDENCE_SCOPE_NOT_OVERRIDABLE",
        "Evidence is always scoped to the authenticated caller's own wallet; walletAddress/userId query parameters are not accepted",
      );
    }

    const { id: arenaId, roundNumber } = req.params as any;
    const userId = req.user?.id;
    const walletAddress = req.user?.walletAddress;

    if (!userId || !walletAddress) {
      throw apiError(401, "UNAUTHORIZED", "Unauthorized");
    }

    try {
      const evidence = await this.getDisputeEvidenceService().generatePackage(
        arenaId,
        Number(roundNumber),
        { userId, walletAddress },
      );
      res.json({ success: true, data: evidence });
    } catch (error) {
      if (error instanceof EvidenceArenaNotFoundError) {
        throw apiError(404, "ARENA_NOT_FOUND", error.message);
      }
      if (error instanceof EvidenceRoundNotFoundError) {
        throw apiError(404, "ROUND_NOT_FOUND", error.message);
      }
      if (error instanceof EvidenceNotParticipantError) {
        throw apiError(403, "EVIDENCE_NOT_PARTICIPANT", error.message);
      }
      throw error;
    }
  }

  async syncPlayers(req: Request, res: Response) {
    const id = req.params.id!;
    const caller = req.user?.walletAddress;
    if (!caller) throw apiError(401, "UNAUTHORIZED", "Unauthorized");

    const result = await this.arenaParticipantsService.syncPlayers(id, caller);
    res.json(result);
  }

  async getArenaHealth(req: Request, res: Response) {
    const id = req.params.id!;
    await this.arenaQueryService.getArenaById(id);
    const health = await this.arenaHealthService.getArenaHealth(id);
    res.json(health);
  }
}
