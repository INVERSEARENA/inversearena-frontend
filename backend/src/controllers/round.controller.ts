import { NextFunction, Request, Response } from 'express';
import { RoundService, IdempotencyConflictError } from '../services/roundService';
import { RoundInputSchema, RoundState } from '../types/round';
import type { RoundInput } from '../types/round';
import { apiError, HttpError } from '../utils/apiError';

const IDEMPOTENCY_KEY_REGEX = /^[a-zA-Z0-9:_-]{8,128}$/;

/**
 * Every arena lifecycle command requires this header (#1386) — there is no
 * safe default to fall back to, since a missing key would mean the request
 * can never be deduplicated. Returns null and writes the 400 response
 * itself so callers can `return` immediately on a null result.
 */
function requireIdempotencyKey(req: Request, res: Response): string | null {
  const header = req.headers['x-idempotency-key'];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key || !IDEMPOTENCY_KEY_REGEX.test(key)) {
    res.status(400).json({
      error: {
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'X-Idempotency-Key header is required and must be 8-128 characters (alphanumeric, :, _, -)',
      },
    });
    return null;
  }
  return key;
}

export class RoundController {
  constructor(private roundService: RoundService) { }

  resolveRound = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const idempotencyKey = requireIdempotencyKey(req, res);
    if (!idempotencyKey) return;

    const input = RoundInputSchema.parse(req.body) as RoundInput;

    try {
      const resolution = await this.roundService.resolveRoundIdempotent(idempotencyKey, input);
      res.json({
        success: true,
        data: resolution,
      });
    } catch (error) {
      next(this.mapError(error, 'resolve'));
    }
  };

  closeRound = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { id } = req.params;

    if (!id) {
      next(apiError(400, 'ROUND_ID_REQUIRED', 'Round ID is required'));
      return;
    }

    const idempotencyKey = requireIdempotencyKey(req, res);
    if (!idempotencyKey) return;

    try {
      const round = await this.roundService.closeRoundIdempotent(idempotencyKey, id);
      res.json({ success: true, data: { roundId: id, state: RoundState.CLOSED, round } });
    } catch (error) {
      next(this.mapError(error, 'close'));
    }
  };

  private mapError(error: unknown, action: 'resolve' | 'close'): Error {
    // Typed client errors (e.g. PayloadLimitError, 413) keep their own
    // status/code rather than being reclassified below — returning them
    // as-is preserves that even though this helper is shared with #1386's
    // idempotency-conflict mapping.
    if (error instanceof HttpError) {
      return error;
    }

    if (error instanceof IdempotencyConflictError) {
      return apiError(error.status, error.code, error.message);
    }

    const message = error instanceof Error
      ? error.message
      : action === 'resolve' ? 'Failed to resolve round' : 'Failed to close round';
    // Both the service-level state guard ("already in state" / "not OPEN")
    // and the repository-level optimistic-lock race ("already resolved/
    // closed by a concurrent request", #1386) represent the same thing to
    // a caller: the round wasn't in the state this command required. Both
    // map to 409, not 500.
    const isConflict =
      message.includes('already in state') ||
      message.includes('not OPEN') ||
      message.includes('already resolved by a concurrent request') ||
      message.includes('already closed by a concurrent request');
    const status = message.includes('not found') ? 404 : isConflict ? 409 : 500;
    const code = status === 404
      ? 'ROUND_NOT_FOUND'
      : status === 409
        ? 'ROUND_INVALID_STATE'
        : action === 'resolve' ? 'ROUND_RESOLVE_FAILED' : 'ROUND_CLOSE_FAILED';
    return apiError(status, code, message);
  }
}
