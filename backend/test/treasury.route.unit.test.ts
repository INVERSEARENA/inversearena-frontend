import express from 'express';
import request from 'supertest';
import { createTreasuryRouter } from '../src/routes/treasury';
import { errorHandler } from '../src/middleware/errorHandler';

function makeFakeRecord(overrides: Partial<any> = {}) {
  return {
    id: 'rec-1',
    network: 'testnet',
    recordType: 'platform_fee',
    arenaId: 'arena-1',
    asset: 'XLM',
    assetIssuer: null,
    sourceTxHash: 'tx-1',
    sourceEventId: 'evt-1',
    sourceLedgerSequence: 100,
    sourceLedgerClosedAt: new Date('2026-01-01T00:00:00.000Z'),
    expectedAmountAtomic: 100_000n,
    configVersion: 1,
    feeBpsApplied: 1000,
    destination: null,
    actualAmountAtomic: null,
    actualTxHash: null,
    actualDestination: null,
    status: 'discrepant',
    discrepancyType: 'missing_transfer',
    reconciledAt: new Date('2026-01-01T00:05:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:05:00.000Z'),
    ...overrides,
  };
}

function buildApp(findManyImpl: (args: any) => Promise<any[]>, adminAuthMiddleware: express.RequestHandler = (_req, res) => {
  res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
}): express.Express {
  const prisma = { treasuryFeeRecord: { findMany: findManyImpl } } as any;
  const app = express();
  app.use('/api/admin', createTreasuryRouter(adminAuthMiddleware, prisma));
  app.use(errorHandler);
  return app;
}

describe('GET /api/admin/treasury/reconciliation', () => {
  it('requires admin auth', async () => {
    const response = await request(buildApp(async () => [])).get('/api/admin/treasury/reconciliation');
    expect(response.status).toBe(401);
  });

  it('returns serialized records with bigint amounts stringified', async () => {
    const findMany = jest.fn().mockResolvedValue([makeFakeRecord()]);
    const app = buildApp(findMany, (_req, _res, next) => next());

    const response = await request(app).get('/api/admin/treasury/reconciliation');

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].expectedAmountAtomic).toBe('100000');
    expect(response.body.items[0].status).toBe('discrepant');
    expect(response.body.hasMore).toBe(false);
    expect(response.body.cursor).toBeNull();
  });

  it('passes status/discrepancyType/arenaId filters through to the query', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const app = buildApp(findMany, (_req, _res, next) => next());

    await request(app).get('/api/admin/treasury/reconciliation?status=discrepant&discrepancyType=amount_mismatch&arenaId=arena-42');

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'discrepant', discrepancyType: 'amount_mismatch', arenaId: 'arena-42' }),
      }),
    );
  });

  it('bounds by ledger range', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const app = buildApp(findMany, (_req, _res, next) => next());

    await request(app).get('/api/admin/treasury/reconciliation?fromLedger=100&toLedger=200');

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ sourceLedgerSequence: { gte: 100, lte: 200 } }),
      }),
    );
  });

  it('rejects fromLedger after toLedger with 400', async () => {
    const app = buildApp(async () => [], (_req, _res, next) => next());
    const response = await request(app).get('/api/admin/treasury/reconciliation?fromLedger=200&toLedger=100');
    expect(response.status).toBe(400);
  });

  it('rejects fromDate after toDate with 400', async () => {
    const app = buildApp(async () => [], (_req, _res, next) => next());
    const response = await request(app).get(
      '/api/admin/treasury/reconciliation?fromDate=2026-02-01&toDate=2026-01-01',
    );
    expect(response.status).toBe(400);
  });

  it('paginates via cursor without exposing secrets — only documented fields are returned', async () => {
    const records = Array.from({ length: 51 }, (_, i) => makeFakeRecord({ id: `rec-${i}`, sourceEventId: `evt-${i}` }));
    const findMany = jest.fn().mockResolvedValue(records); // 51 = default limit(50) + 1 lookahead
    const app = buildApp(findMany, (_req, _res, next) => next());

    const response = await request(app).get('/api/admin/treasury/reconciliation');

    expect(response.body.items).toHaveLength(50);
    expect(response.body.hasMore).toBe(true);
    expect(typeof response.body.cursor).toBe('string');

    const allowedKeys = new Set([
      'id', 'network', 'recordType', 'arenaId', 'asset', 'assetIssuer',
      'sourceTxHash', 'sourceEventId', 'sourceLedgerSequence', 'sourceLedgerClosedAt',
      'expectedAmountAtomic', 'configVersion', 'feeBpsApplied', 'destination',
      'actualAmountAtomic', 'actualTxHash', 'actualDestination', 'status',
      'discrepancyType', 'reconciledAt', 'createdAt', 'updatedAt',
    ]);
    for (const key of Object.keys(response.body.items[0])) {
      expect(allowedKeys.has(key)).toBe(true);
    }
  });

  it('rejects an out-of-range limit with 400', async () => {
    const app = buildApp(async () => [], (_req, _res, next) => next());
    const response = await request(app).get('/api/admin/treasury/reconciliation?limit=500');
    expect(response.status).toBe(400);
  });
});
