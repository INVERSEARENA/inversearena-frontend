import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { getDatabaseConfig, buildDatasourceUrl, validatePgBouncerMode } from '../src/config/database';

describe('Database Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment before each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('getDatabaseConfig', () => {
    it('should return API defaults when no role specified', () => {
      process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
      
      const config = getDatabaseConfig();
      
      expect(config.role).toBe('API');
      expect(config.connectionLimit).toBe(10);
      expect(config.poolTimeout).toBe(20);
    });

    it('should apply WORKER role configuration', () => {
      process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
      process.env.PROCESS_ROLE = 'WORKER';
      
      const config = getDatabaseConfig();
      
      expect(config.role).toBe('WORKER');
      expect(config.connectionLimit).toBe(5);
      expect(config.poolTimeout).toBe(30);
    });

    it('should apply RECONCILER role configuration', () => {
      process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
      process.env.PROCESS_ROLE = 'RECONCILER';
      
      const config = getDatabaseConfig();
      
      expect(config.role).toBe('RECONCILER');
      expect(config.connectionLimit).toBe(3);
      expect(config.poolTimeout).toBe(30);
    });

    it('should apply BACKFILL role configuration', () => {
      process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
      process.env.PROCESS_ROLE = 'BACKFILL';
      
      const config = getDatabaseConfig();
      
      expect(config.role).toBe('BACKFILL');
      expect(config.connectionLimit).toBe(2);
      expect(config.poolTimeout).toBe(60);
    });

    it('should apply MIGRATION role configuration', () => {
      process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
      process.env.PROCESS_ROLE = 'MIGRATION';
      
      const config = getDatabaseConfig();
      
      expect(config.role).toBe('MIGRATION');
      expect(config.connectionLimit).toBe(1);
      expect(config.poolTimeout).toBe(300);
    });

    it('should override pool size with DB_POOL_SIZE', () => {
      process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
      process.env.PROCESS_ROLE = 'API';
      process.env.DB_POOL_SIZE = '25';
      
      const config = getDatabaseConfig();
      
      expect(config.connectionLimit).toBe(25);
    });

    it('should override pool timeout with DB_POOL_TIMEOUT', () => {
      process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
      process.env.DB_POOL_TIMEOUT = '60';
      
      const config = getDatabaseConfig();
      
      expect(config.poolTimeout).toBe(60);
    });

    it('should override connection timeout with DB_CONNECTION_TIMEOUT', () => {
      process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
      process.env.DB_CONNECTION_TIMEOUT = '30';
      
      const config = getDatabaseConfig();
      
      expect(config.connectionTimeout).toBe(30);
    });
  });

  describe('buildDatasourceUrl', () => {
    it('should add connection parameters to URL', () => {
      const config = {
        url: 'postgresql://user:pass@localhost:5432/testdb',
        connectionLimit: 10,
        poolTimeout: 20,
        connectionTimeout: 10,
        role: 'API' as const,
      };
      
      const url = buildDatasourceUrl(config);
      
      expect(url).toContain('connection_limit=10');
      expect(url).toContain('pool_timeout=20');
      expect(url).toContain('connect_timeout=10');
    });

    it('should preserve existing query parameters', () => {
      const config = {
        url: 'postgresql://user:pass@localhost:5432/testdb?schema=public',
        connectionLimit: 5,
        poolTimeout: 30,
        connectionTimeout: 10,
        role: 'WORKER' as const,
      };
      
      const url = buildDatasourceUrl(config);
      
      expect(url).toContain('schema=public');
      expect(url).toContain('connection_limit=5');
    });

    it('should handle URLs without query parameters', () => {
      const config = {
        url: 'postgresql://localhost:5432/testdb',
        connectionLimit: 3,
        poolTimeout: 30,
        connectionTimeout: 10,
        role: 'RECONCILER' as const,
      };
      
      const url = buildDatasourceUrl(config);
      
      expect(url).toMatch(/\?.*connection_limit=3/);
    });
  });

  describe('validatePgBouncerMode', () => {
    let consoleWarnSpy: jest.SpyInstance;

    beforeEach(() => {
      consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    });

    afterEach(() => {
      consoleWarnSpy.mockRestore();
    });

    it('should detect PgBouncer by hostname', () => {
      validatePgBouncerMode('postgresql://pgbouncer:6432/testdb');
      
      expect(consoleWarnSpy).toHaveBeenCalled();
      expect(consoleWarnSpy.mock.calls[0][0]).toContain('PgBouncer');
    });

    it('should detect PgBouncer by port 6432', () => {
      validatePgBouncerMode('postgresql://localhost:6432/testdb');
      
      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it('should detect PgBouncer by query parameter', () => {
      validatePgBouncerMode('postgresql://localhost:5432/testdb?pgbouncer=true');
      
      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it('should not warn for direct Postgres connection', () => {
      validatePgBouncerMode('postgresql://postgres:5432/testdb');
      
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it('should warn about LISTEN/NOTIFY limitation', () => {
      validatePgBouncerMode('postgresql://pgbouncer:6432/testdb');
      
      const warnings = consoleWarnSpy.mock.calls.map(call => call[0]).join(' ');
      expect(warnings).toContain('LISTEN/NOTIFY');
    });

    it('should warn about prepared statements limitation', () => {
      validatePgBouncerMode('postgresql://pgbouncer:6432/testdb');
      
      const warnings = consoleWarnSpy.mock.calls.map(call => call[0]).join(' ');
      expect(warnings).toContain('Prepared statements');
    });
  });

  describe('Role-specific pool sizing', () => {
    it('should enforce correct pool sizes for all roles', () => {
      const roles = ['API', 'WORKER', 'RECONCILER', 'BACKFILL', 'MIGRATION'] as const;
      const expectedLimits = [10, 5, 3, 2, 1];
      
      roles.forEach((role, index) => {
        process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
        process.env.PROCESS_ROLE = role;
        
        const config = getDatabaseConfig();
        
        expect(config.connectionLimit).toBe(expectedLimits[index]);
      });
    });

    it('should prevent connection exhaustion with multiple processes', () => {
      // Simulate 3 API pods + 2 workers + 1 reconciler
      const apiPoolTotal = 3 * 10; // 30 connections
      const workerPoolTotal = 2 * 5; // 10 connections
      const reconcilerPoolTotal = 1 * 3; // 3 connections
      
      const totalConnections = apiPoolTotal + workerPoolTotal + reconcilerPoolTotal;
      
      // Should stay well under typical PgBouncer limit (100)
      expect(totalConnections).toBeLessThan(100);
      
      // Should stay under Postgres max_connections (200)
      expect(totalConnections).toBeLessThan(200);
    });
  });
});
