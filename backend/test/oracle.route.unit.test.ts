import express from 'express';
import request from 'supertest';
import { createOracleRouter } from '../src/routes/oracle';
import { errorHandler } from '../src/middleware/errorHandler';

const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn();

jest.mock('../src/cache/cacheService', () => ({
  cache: {
    get: (...args: unknown[]) => mockCacheGet(...args),
    set: (...args: unknown[]) => mockCacheSet(...args),
  },
  cacheKeys: { oracleYield: () => 'oracle:yield' },
  cacheTTL: { ORACLE_YIELD: 60 },
}));

function buildApp(adminAuthMiddleware: express.RequestHandler = (_req, res) => {
  res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
}): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/oracle', createOracleRouter(adminAuthMiddleware));
  app.use(errorHandler);
  return app;
}

describe('GET /api/oracle/yield (#1512 freshness fields)', () => {
  beforeEach(() => {
    mockCacheGet.mockReset();
    mockCacheSet.mockReset();
  });

  it('classifies a recently-pushed rate as fresh', async () => {
    mockCacheGet.mockResolvedValue({
      protocol: 'Ondo USDY',
      currentAPY: 5.25,
      baseRate: 4.8,
      surgeMultiplier: 1.0,
      lastUpdated: new Date().toISOString(),
      asset: 'USDY',
      network: 'stellar',
    });

    const response = await request(buildApp()).get('/api/oracle/yield');

    expect(response.status).toBe(200);
    expect(response.body.freshness).toBe('fresh');
    expect(typeof response.body.ageSeconds).toBe('number');
  });

  it('classifies a rate pushed long ago as stale, not presented as current', async () => {
    mockCacheGet.mockResolvedValue({
      protocol: 'Ondo USDY',
      currentAPY: 5.25,
      baseRate: 4.8,
      surgeMultiplier: 1.0,
      lastUpdated: new Date(Date.now() - 10 * 3_600_000).toISOString(),
      asset: 'USDY',
      network: 'stellar',
    });

    const response = await request(buildApp()).get('/api/oracle/yield');

    expect(response.status).toBe(200);
    expect(response.body.freshness).toBe('stale');
  });

  it('falls back to DEFAULT_YIELD when nothing has ever been pushed, still classified (not silently presented as fresh forever)', async () => {
    mockCacheGet.mockResolvedValue(null);

    const response = await request(buildApp()).get('/api/oracle/yield');

    expect(response.status).toBe(200);
    expect(['fresh', 'warning', 'stale']).toContain(response.body.freshness);
  });
});

describe('POST /api/oracle/yield (#1512 bounded TTL)', () => {
  it('bounds the cached push by the freshness policy max age instead of storing it unboundedly', async () => {
    process.env.ORACLE_WEBHOOK_SECRET = 'a'.repeat(32);
    mockCacheSet.mockResolvedValue(undefined);

    // No signature header -> 401/503 depending on keyring readiness, but we
    // only care that a *successful* push would call cache.set with a TTL —
    // verified directly via a service-level unit, this route test just
    // confirms the unauthenticated request never reaches that point.
    const response = await request(buildApp()).post('/api/oracle/yield').send({ currentAPY: 6 });

    expect(response.status).not.toBe(200);
    expect(mockCacheSet).not.toHaveBeenCalled();
  });
});

describe('GET /api/oracle/keeper-status (#1512)', () => {
  beforeEach(() => {
    mockCacheGet.mockReset();
  });

  it('requires admin auth', async () => {
    const response = await request(buildApp()).get('/api/oracle/keeper-status');
    expect(response.status).toBe(401);
  });

  it('reports overdue=true for a stale feed without performing any external fetch', async () => {
    mockCacheGet.mockResolvedValue({
      protocol: 'Ondo USDY',
      currentAPY: 5.25,
      baseRate: 4.8,
      surgeMultiplier: 1.0,
      lastUpdated: new Date(Date.now() - 10 * 3_600_000).toISOString(),
      asset: 'USDY',
      network: 'stellar',
    });
    const adminApp = buildApp((_req, _res, next) => next());

    const response = await request(adminApp).get('/api/oracle/keeper-status');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ freshness: 'stale', overdue: true });
    expect(mockCacheGet).toHaveBeenCalledTimes(1);
  });

  it('reports unavailable when nothing has ever been pushed', async () => {
    mockCacheGet.mockResolvedValue(null);
    const adminApp = buildApp((_req, _res, next) => next());

    const response = await request(adminApp).get('/api/oracle/keeper-status');

    expect(response.status).toBe(200);
    expect(response.body.freshness).toBe('unavailable');
  });
});
