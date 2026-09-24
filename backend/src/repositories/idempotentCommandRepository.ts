import { Prisma, PrismaClient } from '@prisma/client';

export type IdempotentCommandAction = 'resolve_round' | 'close_round';
export type IdempotentCommandStatus = 'in_progress' | 'completed' | 'failed';

export interface IdempotentCommandData<TResult = unknown> {
  id: string;
  idempotencyKey: string;
  action: IdempotentCommandAction;
  roundId: string;
  status: IdempotentCommandStatus;
  result: TResult | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Request-level idempotency for arena lifecycle commands (#1386). One row
 * per idempotencyKey, claimed atomically before any side effect (on-chain
 * submission, state transition) runs.
 */
export class IdempotentCommandRepository {
  constructor(private prisma: PrismaClient) {}

  /**
   * Atomically claim an idempotency key for a brand-new command. Returns
   * the created row on success, or null if the key already exists — the
   * caller must then look the existing row up via findByKey to decide how
   * to respond (replay a completed result, reject a still-in-progress
   * concurrent request, or allow a retry after a prior failure).
   *
   * Relies on the unique constraint on idempotencyKey as the actual
   * concurrency guard: two requests racing to claim the same key can both
   * reach this call, but the database allows only one insert to succeed.
   */
  async tryClaim(
    idempotencyKey: string,
    action: IdempotentCommandAction,
    roundId: string,
  ): Promise<IdempotentCommandData | null> {
    try {
      const row = await this.prisma.idempotentCommand.create({
        data: {
          idempotencyKey,
          action,
          roundId,
          status: 'in_progress',
        },
      });
      return this.mapRow(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return null;
      }
      throw error;
    }
  }

  async findByKey(idempotencyKey: string): Promise<IdempotentCommandData | null> {
    const row = await this.prisma.idempotentCommand.findUnique({
      where: { idempotencyKey },
    });
    return row ? this.mapRow(row) : null;
  }

  async markCompleted(idempotencyKey: string, result: unknown): Promise<void> {
    await this.prisma.idempotentCommand.update({
      where: { idempotencyKey },
      data: {
        status: 'completed',
        result: this.toJson(result),
        errorMessage: null,
        updatedAt: new Date(),
      },
    });
  }

  async markFailed(idempotencyKey: string, errorMessage: string): Promise<void> {
    await this.prisma.idempotentCommand.update({
      where: { idempotencyKey },
      data: {
        status: 'failed',
        errorMessage,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Reclaim an existing row for a retry, atomically: succeeds only if the
   * row is still in the state the caller expects it to be in
   * (`expectedStatus`), and flips it back to `in_progress` so the retry
   * proceeds under the same row rather than racing a second `tryClaim`
   * (which would always fail — the unique constraint already blocks it).
   *
   * Used for two distinct retry scenarios (#1386):
   *  - A prior attempt FAILED: always reclaimable, no age check — a
   *    failed command is definitionally done and safe to retry immediately.
   *  - A prior attempt is still IN_PROGRESS but old enough to be presumed
   *    abandoned (process crash, restart during work): reclaimable only
   *    once `staleAfterMs` has elapsed since it last moved, so a genuinely
   *    slow-but-alive request (e.g. a long on-chain confirmation poll)
   *    is never raced by a second request running the same side effects.
   *
   * Returns true if this call won the reclaim (the row was in
   * `expectedStatus`, or a stale `in_progress`), false if a concurrent
   * caller reclaimed it first — the loser must re-read the row rather than
   * assume it now owns the retry.
   */
  async reclaimForRetry(
    idempotencyKey: string,
    expectedStatus: 'failed' | 'in_progress',
    staleAfterMs: number,
  ): Promise<boolean> {
    const where =
      expectedStatus === 'failed'
        ? { idempotencyKey, status: 'failed' }
        : {
            idempotencyKey,
            status: 'in_progress',
            updatedAt: { lt: new Date(Date.now() - staleAfterMs) },
          };

    const reclaimed = await this.prisma.idempotentCommand.updateMany({
      where,
      data: { status: 'in_progress', result: Prisma.JsonNull, errorMessage: null, updatedAt: new Date() },
    });
    return reclaimed.count > 0;
  }

  private mapRow(row: {
    id: string;
    idempotencyKey: string;
    action: string;
    roundId: string;
    status: string;
    result: Prisma.JsonValue | null;
    errorMessage: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): IdempotentCommandData {
    return {
      id: row.id,
      idempotencyKey: row.idempotencyKey,
      action: row.action as IdempotentCommandAction,
      roundId: row.roundId,
      status: row.status as IdempotentCommandStatus,
      result: row.result,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
