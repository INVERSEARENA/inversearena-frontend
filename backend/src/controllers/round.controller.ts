import { Request, Response } from 'express';
import { RoundService } from '../services/roundService';
import { RoundInputSchema } from '../types/round';
import type { RoundInput } from '../types/round';

export class RoundController {
  constructor(private roundService: RoundService) {}

  resolveRound = async (req: Request, res: Response): Promise<void> => {
    const input = RoundInputSchema.parse(req.body) as RoundInput;

    try {
      const resolution = await this.roundService.resolveRound(input);
      res.json({
        success: true,
        data: resolution,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to resolve round',
      });
    }
  };
}
