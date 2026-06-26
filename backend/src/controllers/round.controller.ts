import { NextFunction, Request, Response } from 'express';
import { RoundService } from '../services/roundService';
import { RoundInputSchema, RoundState } from '../types/round';
import type { RoundInput } from '../types/round';
import { apiError } from '../utils/apiError';

export class RoundController {
  constructor(private roundService: RoundService) { }

  resolveRound = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const input = RoundInputSchema.parse(req.body) as RoundInput;

    try {

      const resolution = await this.roundService.resolveRound(input);
      res.json({
        success: true,
        data: resolution,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to resolve round';
      next(apiError(500, 'ROUND_RESOLVE_FAILED', message));
    }
  };

  closeRound = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { id } = req.params;

    if (!id) {
      next(apiError(400, 'ROUND_ID_REQUIRED', 'Round ID is required'));
      return;
    }

    try {
      const round = await this.roundService.closeRound(id);
      res.json({ success: true, data: { roundId: id, state: RoundState.CLOSED, round } });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to close round';
      const status = message.includes('not found') ? 404 : message.includes('not OPEN') ? 409 : 500;
      const code = status === 404
        ? 'ROUND_NOT_FOUND'
        : status === 409
          ? 'ROUND_INVALID_STATE'
          : 'ROUND_CLOSE_FAILED';
      next(apiError(status, code, message));
    }
  };
}
