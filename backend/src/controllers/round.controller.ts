import { Request, Response } from 'express';
import { RoundService } from '../services/roundService';
import type { RoundInput } from '../types/round';

export class RoundController {
  constructor(private roundService: RoundService) {}

  resolveRound = async (req: Request, res: Response): Promise<void> => {
    try {
      const input: RoundInput = req.body;

      if (!input.roundId || !input.playerChoices || input.oracleYield === undefined) {
        res.status(400).json({ error: 'Missing required fields' });
        return;
      }

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
